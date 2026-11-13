namespace pxsim {
    // manages graph identity, static bypassing, and two-pass serialization
    export class HeapSnapshotCrawler {
        private nextId = 0;
        private objectToId = new Map<RefObject, number>();
        private pendingQueue: RefObject[] = [];
        public encodedObjects: EncodedObject[] = [];

        public encodeValue = (val: any): EncodedValue => {
            if (val === null || val === undefined) {
                return { type: "primitive", value: val };
            }

            const t = typeof val;
            if (t === "number" || t === "string" || t === "boolean") {
                return { type: "primitive", value: val };
            }

            if (val instanceof RefObject) {
                if (val.gcIsStatic()) {
                    const staticRef = this.getStaticRef(val);
                    return { type: "static", domain: staticRef.domain, key: staticRef.key };
                }

                if (this.objectToId.has(val)) {
                    return { type: "ref", id: this.objectToId.get(val)! };
                }

                const id = this.nextId++;
                this.objectToId.set(val, id);
                this.pendingQueue.push(val);

                return { type: "ref", id: id };
            }

            throw new Error(`Unsupported value type encountered during snapshot traversal: ${t}`);
        };

        public drainQueue(): void {
            while (this.pendingQueue.length > 0) {
                const obj = this.pendingQueue.shift()!;
                const id = this.objectToId.get(obj)!;
                const dto = (obj as any).encode(id, this.encodeValue);
                this.encodedObjects.push(dto);
            }
        }

        private getStaticRef(obj: RefObject): { domain: "globals" | "env"; key: string } {
            const globals = pxsim.runtime.globals;
            const envGlobals = pxsim.runtime.environmentGlobals;

            if (globals) {
                for (const key of Object.keys(globals)) {
                    if (globals[key] === obj) {
                        return { domain: "globals", key };
                    }
                }
            }

            if (envGlobals) {
                for (const key of Object.keys(envGlobals)) {
                    if (envGlobals[key] === obj) {
                        return { domain: "env", key };
                    }
                }
            }

            throw new Error("fatal: could not resolve stable string key for static object");
        }
    }

    const STANDARD_FRAME_KEYS = new Set([
        "fn", "pc", "overwrittenPC", "depth", "r0", "parent", "retval", 
        "lambdaArgs", "caps", "lastBrkId", "callLocIdx", "arg0", "stage2Call", 
        "tryFrame", "thrownValue", "hasThrownValue", "threadId"
    ]);

    // dto schemas capturing exact PXT interfaces
    export interface EncodedTryFrame {
        handlerPC: number;
        parent?: EncodedTryFrame;
        handlerFrameDepth: number; // capture depth to avoid circular serialization
    }

    export interface EncodedStackFrame {
        funcSymbol: string;
        pc: number;
        depth: number;
        overwrittenPC?: boolean;
        lastBrkId?: number;
        callLocIdx?: number;
        stage2Call?: boolean;
        threadId?: number;
        hasThrownValue?: boolean;
        
        parent?: EncodedStackFrame;
        tryFrame?: EncodedTryFrame;

        // dynamic locals and explicitly typed registers
        registers: Record<string, EncodedValue>;
        
        lambdaArgs?: EncodedValue[];
        caps?: EncodedValue[];
    }

    // --- encoding (pass 1) ---

    export function encodeTryFrame(tf: TryFrame): EncodedTryFrame {
        return {
            handlerPC: tf.handlerPC,
            handlerFrameDepth: tf.handlerFrame.depth,
            parent: tf.parent ? encodeTryFrame(tf.parent) : undefined
        };
    }

    export function encodeFrame(frame: StackFrame, encodeValue: (v: any) => EncodedValue): EncodedStackFrame {
        const fn = frame.fn as any;
        const symbolKey = typeof fn.symbol === "string" ? fn.symbol : (typeof fn.fnId === "number" ? `__fnId_${fn.fnId}` : null);
        
        if (!symbolKey) {
            throw new Error("fatal: cannot serialize frame without stable function symbol or fnId");
        }

        const dto: EncodedStackFrame = {
            funcSymbol: symbolKey,
            pc: frame.pc,
            depth: frame.depth,
            registers: {}
        };

        // primitives mapping
        if (frame.overwrittenPC !== undefined) dto.overwrittenPC = frame.overwrittenPC;
        if (frame.lastBrkId !== undefined) dto.lastBrkId = frame.lastBrkId;
        if (frame.callLocIdx !== undefined) dto.callLocIdx = frame.callLocIdx;
        if (frame.stage2Call !== undefined) dto.stage2Call = frame.stage2Call;
        if (frame.threadId !== undefined) dto.threadId = frame.threadId;
        if (frame.hasThrownValue !== undefined) dto.hasThrownValue = frame.hasThrownValue;

        // explicit PXT registers
        if (frame.r0 !== undefined) dto.registers["r0"] = encodeValue(frame.r0);
        if (frame.arg0 !== undefined) dto.registers["arg0"] = encodeValue(frame.arg0);
        if (frame.retval !== undefined) dto.registers["retval"] = encodeValue(frame.retval);
        if (frame.thrownValue !== undefined) dto.registers["thrownValue"] = encodeValue(frame.thrownValue);

        // captured arrays
        if (frame.lambdaArgs) dto.lambdaArgs = frame.lambdaArgs.map(encodeValue);
        if (frame.caps) dto.caps = frame.caps.map(encodeValue);

        // exception context unwinding
        if (frame.tryFrame) dto.tryFrame = encodeTryFrame(frame.tryFrame);

        // recursive stack unwinding
        if (frame.parent) dto.parent = encodeFrame(frame.parent, encodeValue);

        // dynamic locals extraction
        for (const key of Object.keys(frame)) {
            if (!STANDARD_FRAME_KEYS.has(key)) {
                dto.registers[key] = encodeValue((frame as any)[key]);
            }
        }

        return dto;
    }

    // centralized decoder utility exported for use across all pass-2 restorations
    export function decodeValue(encodedVal: EncodedValue, resolveRef: (id: number) => any): any {
        if (encodedVal === null || encodedVal === undefined) return encodedVal;
        
        if (encodedVal.type === "primitive") return encodedVal.value;
        if (encodedVal.type === "ref") return resolveRef(encodedVal.id);
        if (encodedVal.type === "static") {
            return encodedVal.domain === "globals" 
                ? pxsim.runtime.globals[encodedVal.key] 
                : pxsim.runtime.environmentGlobals[encodedVal.key];
        }
        
        return undefined;
    }

    export function decodeTryFrame(dto: EncodedTryFrame, currentFrame: StackFrame): TryFrame {
        let handlerNode: StackFrame | undefined = currentFrame;
        
        // resolve cyclic handlerFrame reference by matching depth up the parent chain
        while (handlerNode && handlerNode.depth !== dto.handlerFrameDepth) {
            handlerNode = handlerNode.parent;
        }
        
        if (!handlerNode) {
            throw new Error(`fatal: could not find handlerFrame at depth ${dto.handlerFrameDepth}`);
        }

        return {
            handlerPC: dto.handlerPC,
            handlerFrame: handlerNode,
            parent: dto.parent ? decodeTryFrame(dto.parent, currentFrame) : undefined
        };
    }

    export function decodeFrame(
        dto: EncodedStackFrame, 
        resolveRef: (id: number) => any, 
        resolveFunctionSymbol: (sym: string) => LabelFn
    ): StackFrame {
        
        // relink function to static compiled state
        const frame: StackFrame = {
            fn: resolveFunctionSymbol(dto.funcSymbol),
            pc: dto.pc,
            depth: dto.depth,
            parent: null as any 
        };

        // restore flags
        if (dto.overwrittenPC !== undefined) frame.overwrittenPC = dto.overwrittenPC;
        if (dto.lastBrkId !== undefined) frame.lastBrkId = dto.lastBrkId;
        if (dto.callLocIdx !== undefined) frame.callLocIdx = dto.callLocIdx;
        if (dto.stage2Call !== undefined) frame.stage2Call = dto.stage2Call;
        if (dto.threadId !== undefined) frame.threadId = dto.threadId;
        if (dto.hasThrownValue !== undefined) frame.hasThrownValue = dto.hasThrownValue;

        // inject explicit registers and dynamic locals directly back onto the frame
        for (const key of Object.keys(dto.registers)) {
            (frame as any)[key] = decodeValue(dto.registers[key], resolveRef);
        }

        if (dto.lambdaArgs) frame.lambdaArgs = dto.lambdaArgs.map(v => decodeValue(v, resolveRef));
        if (dto.caps) frame.caps = dto.caps.map(v => decodeValue(v, resolveRef));

        // reconstruct parent chain
        if (dto.parent) {
            frame.parent = decodeFrame(dto.parent, resolveRef, resolveFunctionSymbol);
        }

        // restore TryFrames after parent chain is built so handlerFrame can correctly resolve by depth
        if (dto.tryFrame) {
            frame.tryFrame = decodeTryFrame(dto.tryFrame, frame);
        }

        return frame;
    }
}