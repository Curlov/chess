// worker/moveWorker.js

self.addEventListener("error", (e) => {
    console.error(
        "Worker global error:",
        e.message,
        "in", e.filename,
        ":", e.lineno,
        ":", e.colno
    );
});

self.onmessage = function (e) {
    const data = e.data || {};
    const action = data.action || "moves";

    if (action === "moves") {
        handleGetMoves(data);
    } else if (action === "apply") {
        handleApplyMove(data);
    } else {
        console.warn("Unknown action in moveWorker:", action, data);
    }
};

/**
 * Aktion 1: Legal Moves berechnen
 * Erwartet: { action: "moves", fen, field }
 * Antwort:  { action: "moves", moves: number[] }
 */
function handleGetMoves({ fen, field }) {
    //console.log("Worker[moves]:", { fen, field });

    field = Number(field);

    const {
        figure,
        occupiedFields,
        whiteFields
    } = buildPositionFromFen(fen, field);

    //console.log("Worker[moves]: figure auf Feld", field, "=", figure);

    if (!figure) {
        self.postMessage({ action: "moves", moves: [] });
        return;
    }

    const occupiedSet = new Set(occupiedFields);
    const whiteSet    = new Set(whiteFields);

    const moves = calculateValidMoves(field, figure, occupiedSet, whiteSet);

    //console.log("Worker[moves]: moves =", moves);
    self.postMessage({ action: "moves", moves });
}

/**
 * Aktion 2: Zug anwenden
 * Erwartet: { action: "apply", fen, from, to }
 * Antwort:  { action: "apply", fen: newFen }
 */
function handleApplyMove({ fen, from, to }) {
    //console.log("Worker[apply]:", { fen, from, to });

    from = Number(from);
    to   = Number(to);

    const newFen = applyMoveToFen(fen, from, to);

    //console.log("Worker[apply]: newFen =", newFen);
    self.postMessage({ action: "apply", fen: newFen });
}

/**
 * FEN nach 0=a1-Board + Figur auf field
 */
function buildPositionFromFen(fen, field) {
    const [boardPart] = fen.split(" ");
    const ranks = boardPart.split("/");

    const board          = new Array(64).fill(null);
    const occupiedFields = [];
    const whiteFields    = [];

    if (ranks.length !== 8) {
        console.warn("Worker: FEN hat nicht 8 Ränge:", fen);
        return { figure: null, occupiedFields: [], whiteFields: [] };
    }

    // 0=a1, 7=h1, 56=a8, 63=h8
    let row = 7; // Rank 8

    for (const rank of ranks) {
        let col = 0;

        for (const ch of rank) {
            if (ch >= "1" && ch <= "8") {
                col += parseInt(ch, 10);
            } else {
                const idx = row * 8 + col;
                board[idx] = ch;
                occupiedFields.push(idx);

                if (ch === ch.toUpperCase()) {
                    whiteFields.push(idx);
                }

                col++;
            }
        }

        row--; // Rank 7 ... Rank 1
    }

    const figure = board[field] || null;
    return { figure, occupiedFields, whiteFields };
}

/**
 * FEN -> Array[64] (0=a1)
 */
function fenBoardToArray(boardPart) {
    const ranks = boardPart.split("/");
    const board = new Array(64).fill(null);

    if (ranks.length !== 8) {
        throw new Error("Ungültige FEN (Board-Teil): " + boardPart);
    }

    let row = 7; // Rank 8
    for (const rank of ranks) {
        let col = 0;

        for (const ch of rank) {
            if (ch >= "1" && ch <= "8") {
                col += parseInt(ch, 10);
            } else {
                const idx = row * 8 + col;
                board[idx] = ch;
                col++;
            }
        }

        row--;
    }

    return board;
}

/**
 * Array[64] (0=a1) -> FEN-Board-Teil
 */
function arrayToFenBoard(board) {
    const ranks = [];

    // von oben nach unten (8 -> 1)
    for (let row = 7; row >= 0; row--) {
        let empty = 0;
        let rankStr = "";

        for (let col = 0; col < 8; col++) {
            const idx = row * 8 + col;
            const piece = board[idx];

            if (!piece) {
                empty++;
            } else {
                if (empty > 0) {
                    rankStr += empty;
                    empty = 0;
                }
                rankStr += piece;
            }
        }

        if (empty > 0) {
            rankStr += empty;
        }

        ranks.push(rankStr);
    }

    return ranks.join("/");
}

/**
 * Simple Move-Anwendung: FEN + from/to -> neue FEN
 * KEINE Rochade, KEIN en passant, KEINE Promotion.
 * Für dein aktuelles Setup reicht das, Rust-Engine übernimmt später.
 */
function applyMoveToFen(fen, from, to) {
    const parts = fen.split(" ");
    if (parts.length < 4) {
        throw new Error("Ungültige FEN: " + fen);
    }

    const [boardPart, sideToMove, castling, ep, halfmoveStr = "0", fullmoveStr = "1"] = parts;

    const board = fenBoardToArray(boardPart);

    const piece = board[from];
    if (!piece) {
        console.warn("applyMoveToFen: kein Stein auf from-Feld", { from, fen });
        return fen;
    }

    const targetPiece = board[to];
    const isCapture   = targetPiece != null;
    const isPawnMove  = piece.toLowerCase() === "p";

    // Zug anwenden (brutal)
    board[to]   = piece;
    board[from] = null;

    const newBoardPart = arrayToFenBoard(board);

    // Zugrecht flippen
    const newSide = sideToMove === "w" ? "b" : "w";

    // Halfmove-Clock
    let halfmove = parseInt(halfmoveStr, 10);
    if (isPawnMove || isCapture) {
        halfmove = 0;
    } else {
        halfmove = halfmove + 1;
    }

    // Fullmove-Nummer: nach schwarzem Zug erhöhen
    let fullmove = parseInt(fullmoveStr, 10);
    if (sideToMove === "b") {
        fullmove = fullmove + 1;
    }

    // Castling + en passant: erstmal nullen (Rust macht das später richtig)
    const newCastling = "-";
    const newEp       = "-";

    const newFen = `${newBoardPart} ${newSide} ${newCastling} ${newEp} ${halfmove} ${fullmove}`;
    return newFen;
}

/**
 * ====== DEINE BEKANNTE MOVE-LOGIK ======
 */

function calculateValidMoves(field, figure, occupiedFields, whiteFields) {
    const isWhitePiece = (figure === figure.toUpperCase());

    const ownFields   = new Set();
    const enemyFields = new Set();

    for (const sq of occupiedFields) {
        const isWhiteOnSq = whiteFields.has(sq);
        if (isWhiteOnSq === isWhitePiece) {
            ownFields.add(sq);
        } else {
            enemyFields.add(sq);
        }
    }

    let targets = [];

    switch (figure) {
        case "K":
        case "k":
            targets = getKingMoves(field, ownFields, enemyFields);
            break;
        case "Q":
        case "q":
            targets = getQueenMoves(field, ownFields, enemyFields);
            break;
        case "B":
        case "b":
            targets = getBishopMoves(field, ownFields, enemyFields);
            break;
        case "N":
        case "n":
            targets = getKnightMoves(field, ownFields);
            break;
        case "R":
        case "r":
            targets = getRookMoves(field, ownFields, enemyFields);
            break;
        case "P":
        case "p":
            // TODO: Bauern später
            targets = [];
            break;
    }

    return targets;
}

function getCoords(field) {
    const row = Math.floor(field / 8);
    const col = field % 8;
    return { row, col };
}

function inBounds(row, col) {
    return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function toField(row, col) {
    return row * 8 + col;
}

function getKingMoves(field, ownFields, enemyFields) {
    const moves = [];
    const { row, col } = getCoords(field);

    const deltas = [
        [-1, -1], [-1, 0], [-1, 1],
        [ 0, -1],          [ 0, 1],
        [ 1, -1], [ 1, 0], [ 1, 1],
    ];

    for (const [dr, dc] of deltas) {
        const r = row + dr;
        const c = col + dc;
        if (!inBounds(r, c)) continue;
        const target = toField(r, c);
        if (ownFields.has(target)) continue;
        moves.push(target);
    }

    return moves;
}

function getRookMoves(field, ownFields, enemyFields) {
    const moves = [];
    const { row, col } = getCoords(field);

    const directions = [
        [-1, 0],
        [ 1, 0],
        [ 0,-1],
        [ 0, 1],
    ];

    for (const [dr, dc] of directions) {
        let r = row + dr;
        let c = col + dc;

        while (inBounds(r, c)) {
            const target = toField(r, c);
            if (ownFields.has(target)) break;

            moves.push(target);

            if (enemyFields.has(target)) break;

            r += dr;
            c += dc;
        }
    }

    return moves;
}

function getBishopMoves(field, ownFields, enemyFields) {
    const moves = [];
    const { row, col } = getCoords(field);

    const directions = [
        [-1,-1],
        [-1, 1],
        [ 1,-1],
        [ 1, 1],
    ];

    for (const [dr, dc] of directions) {
        let r = row + dr;
        let c = col + dc;

        while (inBounds(r, c)) {
            const target = toField(r, c);
            if (ownFields.has(target)) break;

            moves.push(target);

            if (enemyFields.has(target)) break;

            r += dr;
            c += dc;
        }
    }

    return moves;
}

function getQueenMoves(field, ownFields, enemyFields) {
    const rook   = getRookMoves(field, ownFields, enemyFields);
    const bishop = getBishopMoves(field, ownFields, enemyFields);
    return [...rook, ...bishop];
}

function getKnightMoves(field, ownFields) {
    const moves = [];
    const { row, col } = getCoords(field);

    const deltas = [
        [-2,-1], [-2, 1],
        [-1,-2], [-1, 2],
        [ 1,-2], [ 1, 2],
        [ 2,-1], [ 2, 1],
    ];

    for (const [dr, dc] of deltas) {
        const r = row + dr;
        const c = col + dc;
        if (!inBounds(r, c)) continue;
        const target = toField(r, c);
        if (ownFields.has(target)) continue;
        moves.push(target);
    }

    return moves;
}
