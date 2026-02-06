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
    }

    // FEN initialisieren und rendern
    initPosition(fen) {
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


}
