import ValidMovesEngine from "./ValidMovesEngine.js";
import { 
    lanToField, 
    fieldToLan, 
    fenZuFigurenListe, 
    getStartFen, 
    getPuzzleFen  
} from '../utils/utilitys.js';

export default class GameController {
    constructor(board, moveList, options = {}) {
        this.board    = board;
        this.moveList = moveList;

        this.baseFen     = null; // Basisstellung (Start, Puzzle, egal)
        this.currentFen  = null;
        this.currentMeta = null;

        const {
            engineTimeMs = 15000,
            engineMinTimeMs = 1000,
            engineTtMb = 64,
            autoOpponent = true,
            bookPauseMs = 3000,
            onEngineThinkStart = null,
            onEngineThinkProgress = null,
            onEngineThinkEnd = null,
            onGameEnd = null
        } = options || {};

        this.engineTimeMs = engineTimeMs;
        this.engineMinTimeMs = engineMinTimeMs;
        this.engineTtMb = engineTtMb;
        this.autoOpponent = autoOpponent === true;
        this.bookPauseMs = bookPauseMs;
        this.onEngineThinkStart = typeof onEngineThinkStart === "function" ? onEngineThinkStart : null;
        this.onEngineThinkProgress = typeof onEngineThinkProgress === "function" ? onEngineThinkProgress : null;
        this.onEngineThinkEnd = typeof onEngineThinkEnd === "function" ? onEngineThinkEnd : null;
        this.onGameEnd = typeof onGameEnd === "function" ? onGameEnd : null;

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

        this.board.setSideToMove(this.currentMeta.moveRight);
        this.board.renderFen(this.currentMeta.figuresPosition);
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

            const gameEnded = await this._maybeReportGameEnd(this.currentFen, "after_user_move");
            if (gameEnded) {
                return;
            }

            if (this.autoOpponent) {
                await this._autoOpponentMove();
            }

        } catch (err) {
            console.error("Fehler in handleUserMove / applyMove:", err);
        }
    }

    async handleMoveStart(field, figure, color, fromSelection) {
        try {
            
            const moves = await this.engine.getValidMoves(this.currentFen, field);
            console.log("possible moves:", moves);

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
        const { depth = 4, timeMs = 0, ttMb = 128, fen = null, debugRootEval = false, onProgress = null } = options || {};
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
            const HISTORY_LIMIT = 128;
            if (historyList.length > HISTORY_LIMIT) {
                historyList.splice(0, historyList.length - HISTORY_LIMIT);
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
                {
                    gameId: this.gameId,
                    bookEnabled,
                    uciHistory,
                    debugRootEval: debugRootEval === true,
                    onProgress
                }
            );
        } catch (err) {
            console.error("Fehler in search:", err);
            return null;
        }
    }

    async _autoOpponentMove() {
        const fenBefore = this.currentFen;
        if (!fenBefore) return;

        const thinkStart = performance.now();
        if (this.onEngineThinkStart) {
            this.onEngineThinkStart({
                durationMs: this.engineTimeMs,
                displayTimeMs: this.engineTimeMs,
                ttMb: this.engineTtMb
            });
        }

        let result = null;
        let searchFailed = false;
        const handleProgress = (progress) => {
            if (!this.onEngineThinkProgress) return;
            const depth = Number(progress?.depth);
            const nodes = Number(progress?.nodes);
            const elapsedMs = Number(progress?.time_ms);
            this.onEngineThinkProgress({
                durationMs: this.engineTimeMs,
                ttMb: this.engineTtMb,
                depth: Number.isFinite(depth) ? depth : 0,
                nodes: Number.isFinite(nodes) ? nodes : 0,
                elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null
            });
        };
        try {
            result = await this.search({
                fen: fenBefore,
                timeMs: this.engineTimeMs,
                ttMb: this.engineTtMb,
                onProgress: handleProgress
            });
        } catch (err) {
            console.error("autoOpponent: search failed:", err);
            searchFailed = true;
        }

        if (searchFailed) {
            if (this.onEngineThinkEnd) {
                const elapsedMs = performance.now() - thinkStart;
                const remainingMs = Math.max(0, Number(this.engineTimeMs) - elapsedMs);
                this.onEngineThinkEnd({
                    durationMs: this.engineTimeMs,
                    elapsedMs,
                    remainingMs,
                    ttMb: this.engineTtMb,
                    result
                });
            }
            return;
        }

        const minThinkMs = Math.max(0, Number(this.engineMinTimeMs) || 0);
        if (minThinkMs > 0) {
            const elapsedBeforeMove = performance.now() - thinkStart;
            if (elapsedBeforeMove < minThinkMs) {
                await this._sleep(minThinkMs - elapsedBeforeMove);
            }
        }

        if (this.onEngineThinkEnd) {
            const elapsedMs = performance.now() - thinkStart;
            const remainingMs = Math.max(0, Number(this.engineTimeMs) - elapsedMs);
            this.onEngineThinkEnd({
                durationMs: this.engineTimeMs,
                elapsedMs,
                remainingMs,
                ttMb: this.engineTtMb,
                result
            });
        }

        this._logEngineResult(result);

        const bestUci = this._extractBestMove(result);
        if (!bestUci) {
            const outcome = this._inferNoBestMoveOutcome(result, fenBefore);
            if (outcome) {
                this._reportOutcome(outcome, result, "auto_opponent_no_best");
            } else {
                console.warn("autoOpponent: no best move found", result);
            }
            return;
        }

        if (this._isBookResult(result) && Number.isFinite(this.bookPauseMs) && this.bookPauseMs > 0) {
            if (this.onEngineThinkStart) {
                this.onEngineThinkStart({
                    durationMs: this.bookPauseMs,
                    displayTimeMs: this.engineTimeMs,
                    ttMb: this.engineTtMb
                });
            }
            await this._sleep(this.bookPauseMs);
            if (this.onEngineThinkEnd) {
                this.onEngineThinkEnd({
                    durationMs: this.bookPauseMs,
                    elapsedMs: this.bookPauseMs,
                    remainingMs: 0,
                    ttMb: this.engineTtMb,
                    result
                });
            }
        }

        try {
            await this._applyEngineMove(bestUci, fenBefore);
        } catch (err) {
            console.error("autoOpponent: apply failed:", err);
        }
    }

    _extractBestMove(result) {
        if (!result) return "";
        if (typeof result.best === "string" && result.best.trim().length >= 4) {
            return result.best.trim();
        }
        if (typeof result.pv === "string" && result.pv.trim()) {
            return result.pv.trim().split(/\s+/)[0] || "";
        }
        if (result.result && typeof result.result === "object") {
            const nested = result.result;
            if (typeof nested.best === "string" && nested.best.trim().length >= 4) {
                return nested.best.trim();
            }
            if (typeof nested.pv === "string" && nested.pv.trim()) {
                return nested.pv.trim().split(/\s+/)[0] || "";
            }
        }
        return "";
    }

    _logEngineResult(result) {
        if (!result || typeof result !== "object") {
            console.log("[engine] result", result);
            return;
        }
        const r = result.result && typeof result.result === "object" ? result.result : result;
        const nodesValue = r.nodes_total ?? r.nodesTotal ?? r.nodes ?? null;
        const nodesCompleted = r.nodes_completed ?? r.nodesCompleted ?? r.nodes ?? null;
        const depthRaw = Number(r.depth);
        const hasDeeperWork = Number(nodesValue) > Number(nodesCompleted);
        const depthDisplay = Number.isFinite(depthRaw)
            ? depthRaw + (hasDeeperWork ? 1 : 0)
            : (r.depth ?? null);
        const summary = {
            depth: depthDisplay,
            score: r.score ?? null,
            nodes: nodesValue,
            nps: r.nps ?? null,
            best: r.best ?? null,
            pv: r.pv ?? null,
            ms: r.time_ms ?? null,
            book: r.book === true
        };
        console.log("[engine] result", summary);
    }

    _isBookResult(result) {
        if (!result) return false;
        if (result.book === true) return true;
        if (result.result && typeof result.result === "object" && result.result.book === true) return true;
        return false;
    }

    _unwrapSearchResult(result) {
        if (!result || typeof result !== "object") return null;
        if (result.result && typeof result.result === "object") {
            return result.result;
        }
        return result;
    }

    _colorName(side) {
        return side === "w" ? "White" : side === "b" ? "Black" : "Unknown";
    }

    _oppositeColor(side) {
        if (side === "w") return "b";
        if (side === "b") return "w";
        return null;
    }

    _inferNoBestMoveOutcome(result, fenBefore) {
        const r = this._unwrapSearchResult(result);
        const sideToMove = this._getSideToMove(fenBefore);
        const halfmoveClock = this._getHalfmoveClock(fenBefore);
        const score = Number(r?.score);
        const hasScore = Number.isFinite(score);
        const MATE_SCORE_THRESHOLD = 29990;

        if (Number.isFinite(halfmoveClock) && halfmoveClock >= 100) {
            return {
                reason: "fifty_move_rule",
                winner: null,
                sideToMove,
                score: hasScore ? score : 0,
                message: "Draw (50-move rule)."
            };
        }

        if (hasScore && sideToMove && score <= -MATE_SCORE_THRESHOLD) {
            const winner = this._oppositeColor(sideToMove);
            return {
                reason: "checkmate",
                winner,
                sideToMove,
                score,
                message: `${this._colorName(winner)} has won (checkmate).`
            };
        }

        if (hasScore && score === 0) {
            return {
                reason: "stalemate",
                winner: null,
                sideToMove,
                score,
                message: "Draw (stalemate)."
            };
        }

        if (hasScore && sideToMove && score !== 0) {
            const winner = score > 0 ? sideToMove : this._oppositeColor(sideToMove);
            return {
                reason: "score_decisive",
                winner,
                sideToMove,
                score,
                message: `${this._colorName(winner)} has won (score ${score}).`
            };
        }

        return {
            reason: "unknown",
            winner: null,
            sideToMove,
            score: hasScore ? score : null,
            message: "no best move found (unable to classify end state)"
        };
    }

    _reportOutcome(outcome, result = null, context = "game_end") {
        if (!outcome || typeof outcome !== "object") return;
        const logPayload = {
            context,
            reason: outcome.reason,
            winner: outcome.winner,
            sideToMove: outcome.sideToMove,
            score: outcome.score
        };
        if (outcome.reason === "unknown") {
            console.warn(`game end: ${outcome.message}`, logPayload, result);
            return;
        }
        console.log(`game end: ${outcome.message}`, logPayload);
        if (this.onGameEnd) {
            this.onGameEnd(outcome);
        }
    }

    _sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, Math.max(0, Number(ms) || 0));
        });
    }

    _parseUciMove(uci) {
        if (typeof uci !== "string") return null;
        const token = uci.trim().split(/\s+/)[0];
        if (token.length < 4) return null;
        const from = lanToField(token.slice(0, 2));
        const to = lanToField(token.slice(2, 4));
        if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
        const promo = token.length >= 5 ? token[4] : "";
        return { from, to, promo };
    }

    _getSideToMove(fen) {
        if (!fen || typeof fen !== "string") return null;
        const parts = fen.trim().split(/\s+/);
        if (parts.length < 2) return null;
        const side = parts[1];
        return side === "w" || side === "b" ? side : null;
    }

    _getHalfmoveClock(fen) {
        if (!fen || typeof fen !== "string") return null;
        const parts = fen.trim().split(/\s+/);
        if (parts.length < 5) return null;
        const halfmove = Number(parts[4]);
        return Number.isFinite(halfmove) ? halfmove : null;
    }

    async _applyEngineMove(uci, fenBefore) {
        const parsed = this._parseUciMove(uci);
        if (!parsed) {
            console.warn("applyEngineMove: invalid UCI", uci);
            return;
        }

        const { from, to, promo } = parsed;
        const movingPiece = this.board.getPieceAt(from);

        if (!movingPiece) {
            console.warn("applyEngineMove: piece not found on board", { from, to, uci });
            const fallbackFen = await this.engine.applyMove(fenBefore, from, to, promo);
            this.currentFen = fallbackFen;
            this.currentMeta = fenZuFigurenListe(fallbackFen);
            this.setPositionFromFen(fallbackFen);
            return;
        }

        let capturedPiece = this.board.getPieceAt(to);
        if (movingPiece.dataset.type?.toLowerCase() === "p") {
            if (this.board.enPassantField != null && Number(to) === this.board.enPassantField && !capturedPiece) {
                const isWhite = movingPiece.dataset.type === movingPiece.dataset.type.toUpperCase();
                const capField = isWhite ? Number(to) - 8 : Number(to) + 8;
                const epPiece = this.board.getPieceAt(capField);
                if (epPiece) {
                    capturedPiece = epPiece;
                }
            }
        }

        if (capturedPiece) {
            this.board.playSound('capture');
            this.board.removePieceEffect(capturedPiece);
        } else {
            this.board.playSound('move');
        }

        if (movingPiece.dataset.type?.toLowerCase() === "k" && Math.abs(Number(to) - Number(from)) === 2) {
            this.board.moveCastleRook(from, to);
        }

        const sideToMove = this._getSideToMove(fenBefore);
        const promotion = promo
            ? (sideToMove === "w" ? promo.toUpperCase() : promo.toLowerCase())
            : "";

        this.board.move(from, to, true, () => {
            if (promotion) {
                this.board.promotePiece(from, to, promotion);
            }
        });

        const fenAfter = await this.engine.applyMove(fenBefore, from, to, promotion);

        this.currentFen  = fenAfter;
        this.currentMeta = fenZuFigurenListe(fenAfter);
        this.board.setEnPassant(this.currentMeta.enpassant);
        this.board.setSideToMove(this.currentMeta.moveRight);

        this.moveList?.addMove({
            from,
            to,
            promotion,
            fenBefore,
            fenAfter
        });

        await this._maybeReportGameEnd(this.currentFen, "after_engine_move");

    }

    async _maybeReportGameEnd(fen, context = "game_end_probe") {
        const sideToMove = this._getSideToMove(fen);
        if (this._isKingsOnlyPosition(fen)) {
            this._reportOutcome({
                reason: "insufficient_material",
                winner: null,
                sideToMove,
                score: 0,
                message: "Draw (insufficient material: kings only)."
            }, null, context);
            return true;
        }

        const halfmoveClock = this._getHalfmoveClock(fen);
        if (Number.isFinite(halfmoveClock) && halfmoveClock >= 100) {
            this._reportOutcome({
                reason: "fifty_move_rule",
                winner: null,
                sideToMove,
                score: 0,
                message: "Draw (50-move rule)."
            }, null, context);
            return true;
        }

        const hasLegalMove = await this._hasAnyLegalMove(fen);
        if (hasLegalMove !== false) {
            return false;
        }

        let result = null;
        try {
            result = await this.search({
                fen,
                depth: 1,
                timeMs: 0,
                ttMb: 0
            });
        } catch (err) {
            console.error("game end probe: search failed:", err);
        }

        const outcome = this._inferNoBestMoveOutcome(result, fen);
        if (outcome) {
            this._reportOutcome(outcome, result, context);
            return true;
        }
        return false;
    }

    _isKingsOnlyPosition(fen) {
        if (!fen || typeof fen !== "string") return false;
        const boardPart = fen.trim().split(/\s+/)[0] || "";
        if (!boardPart) return false;

        let whiteKing = 0;
        let blackKing = 0;
        for (const ch of boardPart) {
            if (ch === "/" || (ch >= "1" && ch <= "8")) {
                continue;
            }
            if (ch === "K") {
                whiteKing += 1;
                continue;
            }
            if (ch === "k") {
                blackKing += 1;
                continue;
            }
            return false;
        }
        return whiteKing === 1 && blackKing === 1;
    }

    async _hasAnyLegalMove(fen) {
        const sideToMove = this._getSideToMove(fen);
        if (!sideToMove) return null;

        const fields = this._getPieceFieldsForSide(fen, sideToMove);
        for (const from of fields) {
            const moves = await this.engine.getValidMoves(fen, from);
            if (Array.isArray(moves) && moves.length > 0) {
                return true;
            }
        }
        return false;
    }

    _getPieceFieldsForSide(fen, side) {
        if (!fen || typeof fen !== "string") return [];
        if (side !== "w" && side !== "b") return [];

        const boardPart = fen.trim().split(/\s+/)[0] || "";
        const ranks = boardPart.split("/");
        if (ranks.length !== 8) return [];

        const wantWhite = side === "w";
        const fields = [];
        let rank = 7;

        for (const rankPart of ranks) {
            let file = 0;
            for (const ch of rankPart) {
                if (ch >= "1" && ch <= "8") {
                    file += Number(ch);
                    continue;
                }

                const isWhitePiece = ch >= "A" && ch <= "Z";
                if ((wantWhite && isWhitePiece) || (!wantWhite && !isWhitePiece)) {
                    fields.push(rank * 8 + file);
                }
                file += 1;
            }
            rank -= 1;
        }

        return fields;
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
