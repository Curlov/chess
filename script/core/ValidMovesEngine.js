// script/ValidMovesEngine.js

/**
 * Asynchrone Brücke zwischen UI-Thread und Move-Worker.
 * Verwaltet genau einen aktiven Worker-Request plus Queue.
 */
export default class ValidMovesEngine {
    constructor() {
        const workerUrl = new URL("../worker/moveWorker.js", import.meta.url);
        console.log("ValidMovesEngine: Initialisiere Worker mit URL:", workerUrl.href);

        this.worker = new Worker(workerUrl, { type: "module" });
        this.pending = null;
        this.queue = [];

        // Zentraler Eingang für alle Worker-Antworten.
        this.worker.onmessage = (e) => {
            //console.log("ValidMovesEngine: Worker onmessage (raw):", e.data);
            const payload = e.data || {};

            // Progress-Events gehören zum aktuell laufenden Search-Task
            // und lösen den Promise selbst noch nicht auf.
            if (payload.action === "search-progress") {
                if (
                    this.pending &&
                    this.pending.type === "search" &&
                    typeof this.pending.onProgress === "function"
                ) {
                    this.pending.onProgress(payload);
                }
                return;
            }

            // Defensive Prüfung: Antwort ohne passenden aktiven Task.
            if (!this.pending) {
                console.warn("ValidMovesEngine: Message ohne pending:", payload);
                return;
            }

            const { resolve, type } = this.pending;
            this.pending = null;

            // Antwort je nach Task-Typ auflösen.
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

        // Bei Worker-Fehler: aktiven Task + Queue sauber mit reject beenden.
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

    /** Legt einen Task an und stellt Reihenfolge über die interne Queue sicher. */
    _enqueue(type, message, options = {}) {
        return new Promise((resolve, reject) => {
            const task = {
                type,
                message,
                resolve,
                reject,
                onProgress: typeof options.onProgress === "function" ? options.onProgress : null
            };
            if (this.pending) {
                this.queue.push(task);
                return;
            }
            this._dispatch(task);
        });
    }

    /** Dispatcht den Task direkt an den Worker und setzt ihn auf "pending". */
    _dispatch(task) {
        this.pending = {
            resolve: task.resolve,
            reject: task.reject,
            type: task.type,
            onProgress: task.onProgress
        };
        try {
            this.worker.postMessage(task.message);
        } catch (err) {
            this.pending = null;
            task.reject(err);
            this._drainQueue();
        }
    }

    /** Startet den nächsten Queue-Task, sobald kein Task mehr aktiv ist. */
    _drainQueue() {
        if (this.pending || this.queue.length === 0) {
            return;
        }
        const next = this.queue.shift();
        if (next) {
            this._dispatch(next);
        }
    }

    /** API: legale Zielfelder für eine Startposition abrufen. */
    getValidMoves(fen, field) {
        if (!this.worker) {
            return Promise.reject(new Error("Worker nicht initialisiert"));
        }

        return this._enqueue("moves", {
            action: "moves",
            fen,
            field
        });
    }

    /** API: einen Zug anwenden und die neue FEN zurückgeben. */
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

    /** API: Perft-Berechnung (Knotenanzahl) für eine Position. */
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

    /** API: Engine-Suche mit optionalem Progress-Callback. */
    search(fen, depth = 4, timeMs = 0, ttMb = 0, history = "", bookMeta = null) {
        if (!this.worker) {
            return Promise.reject(new Error("Worker nicht initialisiert"));
        }

        const meta = bookMeta || {};
        const gameId = Number.isFinite(meta.gameId) ? meta.gameId : null;
        const bookEnabled = meta.bookEnabled === true;
        const uciHistory = typeof meta.uciHistory === "string" ? meta.uciHistory : "";
        const debugRootEval = meta.debugRootEval === true;
        const onProgress = typeof meta.onProgress === "function" ? meta.onProgress : null;

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
        }, { onProgress });
    }

    /** Worker explizit beenden, z. B. bei Cleanup/Hot-Reload. */
    terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    }
}
