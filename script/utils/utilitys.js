const FILES = ['a','b','c','d','e','f','g','h'];
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// 0..63 → "e4"
export function fieldToLan(field) {
    const f = Number(field);
    const file = FILES[f % 8];          
    const rank = Math.floor(f / 8) + 1;
    return file + String(rank);
}

// "e4" → 0..63
export function lanToField(lan) {
    const fileIndex = FILES.indexOf(lan[0]); 
    const rank      = Number(lan[1]);        
    const rankIndex = rank - 1;             
    return Number(rankIndex * 8 + fileIndex);
}

// Gibt den FEN als Objekt zurück
export function fenZuFigurenListe(fenString) {
    const [fen, moveRight, rochaRights, enpassant, move50, moveNo] = fenString.split(" ");

    const ranks = fen.split("/");
    let figuresPosition = [];

    // rankIndexFromTop: 0 = 8. Reihe, 7 = 1. Reihe
    for (let rankIndexFromTop = 0; rankIndexFromTop < 8; rankIndexFromTop++) {
        const rankStr = ranks[rankIndexFromTop];
        let file = 0; // 0 = a, 7 = h

        for (let char of rankStr) {
            if (/[a-zA-Z]/.test(char)) {
                const rankFromBottom = 7 - rankIndexFromTop; // 0 = 1. Reihe (unten)
                const field = rankFromBottom * 8 + file;     // Bitboard: 0=a1, 63=h8
                figuresPosition.push({ field, type: char });
                file++;
            } else if (/\d/.test(char)) {
                file += parseInt(char, 10); // Leere Felder überspringen
            }
        }
    }

    return { figuresPosition, moveRight, rochaRights, enpassant, move50, moveNo };
}

// Gibt ein Schachpuzzel im FEN String zurück
export async function getPuzzleFen() {
    try {
        const response = await fetch("https://api.chess.com/pub/puzzle/random");
        const result = await response.json();
        return result.fen;

    } catch (error) {
        return 'Fehler! Die FEN konnte nicht geladen werden.';
    }
}

//Gibt die Sart-Fen
export function getStartFen() {
    return START_FEN;
}

// Perft-Helfer: nutzt GameController und loggt Ergebnis
export async function runPerft(controller, depth = 3, fen = null) {
    if (!controller || typeof controller.perft !== "function") {
        console.warn("runPerft: GameController fehlt oder ist ungueltig");
        return null;
    }

    const targetFen = fen ?? controller.currentFen ?? controller.baseFen ?? getStartFen();
    console.log("[perft] start", { depth, fen: targetFen });
    const t0 = performance.now();
    const result = await controller.perft(depth, targetFen);
    const ms = performance.now() - t0;
    if (result && typeof result.nodes === "number") {
        const timeMs = Number.isFinite(result.ms) ? result.ms : ms;
        console.log("[perft] done", { depth: result.depth ?? depth, nodes: result.nodes, ms: timeMs });
    } else {
        console.log("[perft] done", result);
    }
    return result;
}

