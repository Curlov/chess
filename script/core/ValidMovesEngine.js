// script/ValidMovesEngine.js

export default class ValidMovesEngine {
    constructor() {
        const workerUrl = new URL("../worker/moveWorker.js", import.meta.url);
        console.log("ValidMovesEngine: Initialisiere Worker mit URL:", workerUrl.href);

        this.worker = new Worker(workerUrl, { type: "module" });
        this.pending = null;
        this.queue = [];

        this.worker.onmessage = (e) => {
            //console.log("ValidMovesEngine: Worker onmessage (raw):", e.data);

            if (!this.pending) {
                console.warn("ValidMovesEngine: Message ohne pending:", e.data);
                return;
            }

            const { resolve, type } = this.pending;
            this.pending = null;

            const payload = e.data || {};

            if (type === "moves") {
                resolve(payload.moves || []);
            } else if (type === "apply") {
                resolve(payload.fen);
            } else if (type === "perft") {
                resolve(payload);
            } else if (type === "search") {
                resolve(payload);
            } else {
                console.warn("ValidMovesEngine: unbekannter pending-Typ:", type, payload);
                resolve(payload);
            }

            this._drainQueue();
        };

        this.worker.onerror = (err) => {
            console.error(
                "ValidMovesEngine: Worker onerror",
                "\n  message:", err.message,
                "\n  filename:", err.filename,
                "\n  lineno:", err.lineno,
                "\n  colno:", err.colno,
                "\n  raw:", err
            );

            if (this.pending) {
                const { reject } = this.pending;
                this.pending = null;
                reject(err);
            }
            while (this.queue.length) {
                const task = this.queue.shift();
                if (task) {
                    task.reject(err);
                }
            }
        };
    }

    _enqueue(type, message) {
        return new Promise((resolve, reject) => {
            const task = { type, message, resolve, reject };
            if (this.pending) {
                this.queue.push(task);
                return;
            }
            this._dispatch(task);
        });
    }

    _dispatch(task) {
        this.pending = { resolve: task.resolve, reject: task.reject, type: task.type };
        try {
            this.worker.postMessage(task.message);
        } catch (err) {
            this.pending = null;
            task.reject(err);
            this._drainQueue();
        }
    }

    _drainQueue() {
        if (this.pending || this.queue.length === 0) {
            return;
        }
        const next = this.queue.shift();
        if (next) {
            this._dispatch(next);
        }
    }

    getValidMoves(fen, field) {
        console.log("ValidMovesEngine.getValidMoves:", { fen, field });

        if (!this.worker) {
            return Promise.reject(new Error("Worker nicht initialisiert"));
        }

        return this._enqueue("moves", {
            action: "moves",
            fen,
            field
        });
    }

    applyMove(fen, from, to, promotion = "") {
        //console.log("ValidMovesEngine.applyMove:", { fen, from, to });

        if (!this.worker) {
            return Promise.reject(new Error("Worker nicht initialisiert"));
        }

        return this._enqueue("apply", {
            action: "apply",
            fen,
            from,
            to,
            promotion
        });
    }

    perft(fen, depth = 1) {
        if (!this.worker) {
            return Promise.reject(new Error("Worker nicht initialisiert"));
        }

        return this._enqueue("perft", {
            action: "perft",
            fen,
            depth
        });
    }

    search(fen, depth = 4, timeMs = 0, ttMb = 0, history = "", bookMeta = null) {
        if (!this.worker) {
            return Promise.reject(new Error("Worker nicht initialisiert"));
        }

        const meta = bookMeta || {};
        const gameId = Number.isFinite(meta.gameId) ? meta.gameId : null;
        const bookEnabled = meta.bookEnabled === true;
        const uciHistory = typeof meta.uciHistory === "string" ? meta.uciHistory : "";
        const debugRootEval = meta.debugRootEval === true;

        return this._enqueue("search", {
            action: "search",
            fen,
            depth,
            timeMs,
            ttMb,
            history,
            gameId,
            bookEnabled,
            uciHistory,
            debugRootEval
        });
    }

    terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    }
}
