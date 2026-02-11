import ValidMovesEngine from "./ValidMovesEngine.js";
import { 
    lanToField, 
    fieldToLan, 
    fenZuFigurenListe, 
    getStartFen, 
    getPuzzleFen  
} from '../utils/utilitys.js';

export default class GameController {
    constructor(board, moveList) {
        this.board    = board;
        this.moveList = moveList;

        this.baseFen     = null; // Basisstellung (Start, Puzzle, egal)
        this.currentFen  = null;
        this.currentMeta = null;

        this.board.onUserMove = (from, to, capturedPiece) => {
            this.handleUserMove(from, to, capturedPiece);
        };

        // Figur angehoben / ausgewählt
        this.board.onMoveStart = (field, figure, color, fromSelection) => {
            this.handleMoveStart(field, figure, color, fromSelection);
        };

        // Hier wird der Worker als „Behelfs-Engine“ instanziert
        this.engine = new ValidMovesEngine("../worker/moveWorker.js");

        this.gameId = 0;
    }

    // FEN initialisieren und rendern
    initPosition(fen) {
        this.gameId += 1;
        this.baseFen     = fen;
        this.currentFen  = fen;
        this.currentMeta = fenZuFigurenListe(fen);
        this.moveList.clear();     // neue Partie -> History resetten

        this.setPositionFromFen(fen);
    }

    //FEN rendern
    setPositionFromFen(fen = null) {
        const targetFen = fen ?? this.currentFen;
        if (!targetFen) {
            console.error("keine FEN vorhanden");
            return;
        }

        this.currentFen  = targetFen;
        this.currentMeta = fenZuFigurenListe(targetFen);

        this.board.renderFen(this.currentMeta.figuresPosition);
        this.board.setSideToMove(this.currentMeta.moveRight);
        this.board.setEnPassant(this.currentMeta.enpassant);
    }

    // Navigation in der History
    goToPly(plyIndex) {
        this.moveList.index = plyIndex;

        let fen;
        if (plyIndex < 0) {
            // -1 = Ausgangsbasis
            fen = this.baseFen;
        } else {
            const entry = this.moveList.getAt(plyIndex);
            if (!entry) {
                console.warn("goToPly: kein Eintrag für", plyIndex);
                return;
            }
            fen = entry.fenAfter;
        }

        this.setPositionFromFen(fen);
    }

    async handleUserMove(from, to, capturedPiece) {
        try {
            if (capturedPiece) {
                this.board.playSound('capture');
                this.board.removePieceEffect(capturedPiece);
            } else {
                this.board.playSound('move');
            }
            
            const fenBefore = this.currentFen;
            const movingPiece = this.board.getPieceAt(from);
            let promotion = "";

            if (movingPiece) {
                const type = movingPiece.dataset.type;
                if (type && type.toLowerCase() === "p") {
                    const isWhite = type === type.toUpperCase();
                    const rank = Math.floor(Number(to) / 8);
                    const isPromotion = (isWhite && rank === 7) || (!isWhite && rank === 0);

                    if (isPromotion) {
                        promotion = await this.board.requestPromotion(isWhite ? "w" : "b");
                        this.board.promotePiece(from, to, promotion);
                    }
                }
            }

            // neue FEN aus dem Worker holen
            const fenAfter = await this.engine.applyMove(fenBefore, from, to, promotion);

            console.log("handleUserMove:", { from, to, fenBefore, fenAfter });

            this.currentFen  = fenAfter;
            this.currentMeta = fenZuFigurenListe(fenAfter); 
            this.board.setEnPassant(this.currentMeta.enpassant);

            this.moveList?.addMove({
                from,
                to,
                promotion,
                fenBefore,
                fenAfter
            });

        } catch (err) {
            console.error("Fehler in handleUserMove / applyMove:", err);
        }
    }

    async handleMoveStart(field, figure, color, fromSelection) {
        try {
            console.log("Bin im handleMoveStart", { field, figure, color });

            const moves = await this.engine.getValidMoves(this.currentFen, field);
            console.log("moves:", moves);

            if (!Array.isArray(moves)) return;

            this.board.clearHighlights?.();

            if ((fromSelection === 'mouse' && this.board.showSelectedField === true ) ||
                (fromSelection === 'touch'))  
                {    
                this.board.highlight(field, "s"); 
            }
            
            if (this.board.showLegalMoves === true) {
                this.board.highlight(moves, "f");
            }
            
            this.board.validMoves = moves;

        } catch (err) {
            console.error("Fehler beim Holen der Züge aus dem Worker:", err);
        }
    }

    get sideToMove() {
        return this.currentMeta.moveRight;  // "w" oder "b"
    }

    async perft(depth = 1, fen = null) {
        const targetFen = fen ?? this.currentFen ?? this.baseFen;
        if (!targetFen) {
            console.warn("perft: keine FEN vorhanden");
            return null;
        }

        const d = Number(depth);
        if (!Number.isFinite(d) || d < 0) {
            console.warn("perft: ungültige Tiefe", depth);
            return null;
        }

        try {
            return await this.engine.perft(targetFen, d);
        } catch (err) {
            console.error("Fehler in perft:", err);
            return null;
        }
    }

    async search(options = {}) {
        const { depth = 4, timeMs = 0, ttMb = 128, fen = null, debugRootEval = false } = options || {};
        const targetFen = fen ?? this.currentFen ?? this.baseFen;
        if (!targetFen) {
            console.warn("search: keine FEN vorhanden");
            return null;
        }

        const d = Number(depth);
        const t = Number(timeMs);
        const m = Number(ttMb);
        if ((!Number.isFinite(d) || d < 0) && (!Number.isFinite(t) || t < 0)) {
            console.warn("search: ungültige Tiefe/Time", { depth, timeMs });
            return null;
        }

        const safeTimeMs = Number.isFinite(t) && t > 0 ? t : 0;
        const safeDepth = safeTimeMs > 0 ? 0 : (Number.isFinite(d) && d > 0 ? d : 0);
        const safeTtMb = Number.isFinite(m) && m > 0 ? m : 0;

        const isCurrent = !fen || fen === this.currentFen;
        let history = "";
        let uciHistory = "";
        let bookEnabled = false;
        if (isCurrent) {
            const historyList = [];
            if (this.baseFen) {
                historyList.push(this.baseFen);
            }
            if (this.moveList && Array.isArray(this.moveList.moves)) {
                const end = Math.min(this.moveList.index, this.moveList.moves.length - 1);
                for (let i = 0; i < end; i += 1) {
                    const entry = this.moveList.moves[i];
                    if (entry && typeof entry.fenAfter === "string") {
                        historyList.push(entry.fenAfter);
                    }
                }
            }
            history = historyList.join("\n");

            if (this.baseFen === getStartFen()) {
                const expectedPly = this._getFenPlyCount(this.currentFen);
                const moveCount = this.moveList && Number.isFinite(this.moveList.index)
                    ? Math.max(0, this.moveList.index + 1)
                    : 0;

                if (Number.isFinite(expectedPly) && expectedPly === moveCount) {
                    bookEnabled = true;
                    uciHistory = this._buildUciHistory();
                } else {
                    bookEnabled = false;
                    uciHistory = "";
                }
            }
        }

        try {
            return await this.engine.search(
                targetFen,
                safeDepth,
                safeTimeMs,
                safeTtMb,
                history,
                { gameId: this.gameId, bookEnabled, uciHistory, debugRootEval: debugRootEval === true }
            );
        } catch (err) {
            console.error("Fehler in search:", err);
            return null;
        }
    }

    _buildUciHistory() {
        if (!this.moveList || !Array.isArray(this.moveList.moves)) {
            return "";
        }
        const end = Math.min(this.moveList.index, this.moveList.moves.length - 1);
        if (end < 0) return "";

        const moves = [];
        for (let i = 0; i <= end; i += 1) {
            const entry = this.moveList.moves[i];
            if (!entry) continue;
            const fromIdx = Number(entry.from);
            const toIdx = Number(entry.to);
            if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) continue;
            const from = fieldToLan(fromIdx);
            const to = fieldToLan(toIdx);
            let uci = String(from) + String(to);
            if (entry.promotion && String(entry.promotion).length === 1) {
                uci += String(entry.promotion).toLowerCase();
            }
            moves.push(uci);
        }
        return moves.join(" ");
    }

    _getFenPlyCount(fen) {
        if (!fen || typeof fen !== "string") return null;
        const parts = fen.trim().split(/\s+/);
        if (parts.length < 2) return null;
        const side = parts[1];
        const fullmove = parts.length >= 6 ? Number(parts[5]) : NaN;
        if (!Number.isFinite(fullmove) || fullmove < 1) return null;
        const base = (fullmove - 1) * 2;
        if (side === "b") return base + 1;
        if (side === "w") return base;
        return null;
    }

}
