use wasm_bindgen::prelude::*;

#[inline]
// Erzeugt ein Bitboard mit genau einem gesetzten Bit.
// `sq` ist das Feld 0..63 (a1=0, h8=63).
// Wird für schnelle Maskenbildung in allen Routinen genutzt.
fn bb(sq: u8) -> u64 {
    1u64 << sq
}

#[inline]
// Liefert den Index des niederwertigsten gesetzten Bits.
// Erwartet x != 0, ansonsten Debug-Assertion.
// Wird für Ray-Clipping und Bitboard-Iteration verwendet.
fn lsb_idx(x: u64) -> usize {
    debug_assert!(x != 0);
    x.trailing_zeros() as usize
}

#[inline]
// Liefert den Index des höchstwertigsten gesetzten Bits.
// Erwartet x != 0, ansonsten Debug-Assertion.
// Hilfreich für das Abschneiden von Rays "nach hinten".
fn msb_idx(x: u64) -> usize {
    debug_assert!(x != 0);
    (63 - (x.leading_zeros() as u32)) as usize
}

// ----------------------
// Ray-Generatoren (const)
// ----------------------
// Baut einen Ray nach Nord-Ost ab Feld `sq` (ohne Startfeld).
// Alle Felder bis zum Brettrand sind enthalten.
// Compile-time Funktion für Lookup-Tabellen.
const fn ray_ne_from(sq: u8) -> u64 {
    let mut r = (sq / 8) as i8;
    let mut f = (sq % 8) as i8;
    let mut ray = 0u64;
    while r < 7 && f < 7 {
        r += 1;
        f += 1;
        ray |= 1u64 << ((r as u8) * 8 + (f as u8));
    }
    ray
}

// Baut einen Ray nach Nord-West ab Feld `sq` (ohne Startfeld).
// Wird für Läufer/Queen-Angriffe genutzt.
const fn ray_nw_from(sq: u8) -> u64 {
    let mut r = (sq / 8) as i8;
    let mut f = (sq % 8) as i8;
    let mut ray = 0u64;
    while r < 7 && f > 0 {
        r += 1;
        f -= 1;
        ray |= 1u64 << ((r as u8) * 8 + (f as u8));
    }
    ray
}

// Baut einen Ray nach Süd-Ost ab Feld `sq` (ohne Startfeld).
// Für diagonale Angriffe der weißen/schwarzen Läufer.
const fn ray_se_from(sq: u8) -> u64 {
    let mut r = (sq / 8) as i8;
    let mut f = (sq % 8) as i8;
    let mut ray = 0u64;
    while r > 0 && f < 7 {
        r -= 1;
        f += 1;
        ray |= 1u64 << ((r as u8) * 8 + (f as u8));
    }
    ray
}

// Baut einen Ray nach Süd-West ab Feld `sq` (ohne Startfeld).
// Dient für diagonale Sliding-Angriffe.
const fn ray_sw_from(sq: u8) -> u64 {
    let mut r = (sq / 8) as i8;
    let mut f = (sq % 8) as i8;
    let mut ray = 0u64;
    while r > 0 && f > 0 {
        r -= 1;
        f -= 1;
        ray |= 1u64 << ((r as u8) * 8 + (f as u8));
    }
    ray
}

// Baut einen Ray nach Norden (gleiche Datei) ab Feld `sq`.
// Enthält alle Felder bis zur 8. Reihe, Startfeld ausgeschlossen.
const fn ray_n_from(sq: u8) -> u64 {
    let mut r = (sq / 8) as i8;
    let f = (sq % 8) as i8;
    let mut ray = 0u64;
    while r < 7 {
        r += 1;
        ray |= 1u64 << ((r as u8) * 8 + (f as u8));
    }
    ray
}

// Baut einen Ray nach Süden (gleiche Datei) ab Feld `sq`.
// Enthält alle Felder bis zur 1. Reihe, Startfeld ausgeschlossen.
const fn ray_s_from(sq: u8) -> u64 {
    let mut r = (sq / 8) as i8;
    let f = (sq % 8) as i8;
    let mut ray = 0u64;
    while r > 0 {
        r -= 1;
        ray |= 1u64 << ((r as u8) * 8 + (f as u8));
    }
    ray
}

// Baut einen Ray nach Osten (gleiche Reihe) ab Feld `sq`.
// Enthält alle Felder bis zur h-Linie.
const fn ray_e_from(sq: u8) -> u64 {
    let r = (sq / 8) as i8;
    let mut f = (sq % 8) as i8;
    let mut ray = 0u64;
    while f < 7 {
        f += 1;
        ray |= 1u64 << ((r as u8) * 8 + (f as u8));
    }
    ray
}

// Baut einen Ray nach Westen (gleiche Reihe) ab Feld `sq`.
// Enthält alle Felder bis zur a-Linie.
const fn ray_w_from(sq: u8) -> u64 {
    let r = (sq / 8) as i8;
    let mut f = (sq % 8) as i8;
    let mut ray = 0u64;
    while f > 0 {
        f -= 1;
        ray |= 1u64 << ((r as u8) * 8 + (f as u8));
    }
    ray
}

// ---------------------------
// Const-Tabellen
// ---------------------------
// Erstellt die Ray-Tabelle für Nord-Ost (pro Startfeld).
// Wird einmalig als const-Array erzeugt.
const fn build_ne() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_ne_from(i as u8);
        i += 1;
    }
    a
}
// Erstellt die Ray-Tabelle für Nord-West (pro Startfeld).
// Erlaubt schnellen Zugriff ohne Laufzeitkosten.
const fn build_nw() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_nw_from(i as u8);
        i += 1;
    }
    a
}
// Erstellt die Ray-Tabelle für Süd-Ost (pro Startfeld).
// Grundlage für Sliding-Angriffe.
const fn build_se() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_se_from(i as u8);
        i += 1;
    }
    a
}
// Erstellt die Ray-Tabelle für Süd-West (pro Startfeld).
// Wird für Läufer/Dame benötigt.
const fn build_sw() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_sw_from(i as u8);
        i += 1;
    }
    a
}
// Erstellt die Ray-Tabelle für Norden (pro Startfeld).
// Für Turm/Queen-Angriffe entlang der Datei.
const fn build_n() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_n_from(i as u8);
        i += 1;
    }
    a
}
// Erstellt die Ray-Tabelle für Süden (pro Startfeld).
// Gegenrichtung zu build_n.
const fn build_s() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_s_from(i as u8);
        i += 1;
    }
    a
}
// Erstellt die Ray-Tabelle für Osten (pro Startfeld).
// Für horizontale Sliding-Züge.
const fn build_e() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_e_from(i as u8);
        i += 1;
    }
    a
}
// Erstellt die Ray-Tabelle für Westen (pro Startfeld).
// Ergänzt die horizontalen Richtungen.
const fn build_w() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_w_from(i as u8);
        i += 1;
    }
    a
}

const RAY_NE: [u64; 64] = build_ne();
const RAY_NW: [u64; 64] = build_nw();
const RAY_SE: [u64; 64] = build_se();
const RAY_SW: [u64; 64] = build_sw();
const RAY_N: [u64; 64] = build_n();
const RAY_S: [u64; 64] = build_s();
const RAY_E: [u64; 64] = build_e();
const RAY_W: [u64; 64] = build_w();

const KNIGHT_DELTAS: [(i8, i8); 8] = [
    (-2, -1), (-2, 1),
    (-1, -2), (-1, 2),
    (1, -2),  (1, 2),
    (2, -1),  (2, 1),
];

// Liefert alle Königsschläge von `sq` (max. 8 Nachbarfelder).
// Wird als Lookup-Tabelle vorkalkuliert.
const fn king_attack_from(sq: u8) -> u64 {
    let r = (sq / 8) as i8;
    let f = (sq % 8) as i8;
    let mut attacks = 0u64;
    let mut dr = -1;
    while dr <= 1 {
        let mut df = -1;
        while df <= 1 {
            if !(dr == 0 && df == 0) {
                let rr = r + dr;
                let ff = f + df;
                if rr >= 0 && rr < 8 && ff >= 0 && ff < 8 {
                    attacks |= 1u64 << ((rr as u8) * 8 + (ff as u8));
                }
            }
            df += 1;
        }
        dr += 1;
    }
    attacks
}

// Liefert alle Springer-Schläge von `sq` (max. 8 Ziele).
// Nutzt vordefinierte Deltas für Reihen/Dateien.
const fn knight_attack_from(sq: u8) -> u64 {
    let r = (sq / 8) as i8;
    let f = (sq % 8) as i8;
    let mut attacks = 0u64;
    let mut i = 0;
    while i < 8 {
        let (dr, df) = KNIGHT_DELTAS[i];
        let rr = r + dr;
        let ff = f + df;
        if rr >= 0 && rr < 8 && ff >= 0 && ff < 8 {
            attacks |= 1u64 << ((rr as u8) * 8 + (ff as u8));
        }
        i += 1;
    }
    attacks
}

// Baut die komplette König-Table (64 Felder).
// Zugriff später per KING_ATTACKS[index].
const fn build_king() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = king_attack_from(i as u8);
        i += 1;
    }
    a
}

// Baut die komplette Springer-Table (64 Felder).
// Spart Laufzeitberechnungen pro Zug.
const fn build_knight() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = knight_attack_from(i as u8);
        i += 1;
    }
    a
}

const KING_ATTACKS: [u64; 64] = build_king();
const KNIGHT_ATTACKS: [u64; 64] = build_knight();

// ---------------------------
// Zusätzliche Masken / Flags
// ---------------------------
const FILE_A: u64 = 0x0101_0101_0101_0101;
const FILE_H: u64 = 0x8080_8080_8080_8080;

const CASTLE_WK: u8 = 1;
const CASTLE_WQ: u8 = 2;
const CASTLE_BK: u8 = 4;
const CASTLE_BQ: u8 = 8;

// ---------------------------
// Grundtypen
// ---------------------------
#[derive(Copy, Clone, PartialEq, Eq)]
enum Color {
    White,
    Black,
}

impl Color {
    #[inline]
    // Liefert die Gegenseite der aktuellen Farbe.
    // Hilfreich für Schachprüfungen und Zugrechtwechsel.
    fn opposite(self) -> Color {
        match self {
            Color::White => Color::Black,
            Color::Black => Color::White,
        }
    }
}

#[derive(Copy, Clone)]
enum MoveKind {
    Normal,
    EnPassant,
    Castle,
    Promotion,
}

#[derive(Copy, Clone)]
struct Move {
    from: u8,
    to: u8,
    kind: MoveKind,
}

// Bitboards + Kingsquare (für schnelle Schachprüfung)
struct Bitboards {
    white_occ: u64,
    black_occ: u64,
    occ: u64,
    wp: u64,
    wn: u64,
    wb: u64,
    wr: u64,
    wq: u64,
    wk: u64,
    bp: u64,
    bn: u64,
    bb: u64,
    br: u64,
    bq: u64,
    bk: u64,
    white_king_sq: u8,
    black_king_sq: u8,
}

// Position aus FEN: Board + Metadaten + Bitboards
struct Position {
    board: [Option<char>; 64],
    side_to_move: Color,
    castling: u8,
    ep: Option<u8>,
    halfmove: u32,
    fullmove: u32,
    bb: Bitboards,
}

// ---------------------------
// Clipping (erste Blockerbox)
// ---------------------------
#[inline]
// Schneidet einen Ray an der ersten Blocker-Figur ab (vorwärts Richtung).
// `occ_on_ray` sind nur die Belegungen auf diesem Ray.
// Das Blockerfeld bleibt enthalten, dahinter wird abgeschnitten.
fn clip_forward(ray_from_sq: u64, occ_on_ray: u64, table: &[u64; 64]) -> u64 {
    if occ_on_ray == 0 {
        return ray_from_sq;
    }
    let b = lsb_idx(occ_on_ray);
    ray_from_sq ^ table[b]
}

#[inline]
// Schneidet einen Ray an der ersten Blocker-Figur ab (rückwärts Richtung).
// Nutzt MSB, um den nächsten Blocker „hinter“ dem Start zu finden.
// Das Blockerfeld bleibt enthalten.
fn clip_backward(ray_from_sq: u64, occ_on_ray: u64, table: &[u64; 64]) -> u64 {
    if occ_on_ray == 0 {
        return ray_from_sq;
    }
    let b = msb_idx(occ_on_ray);
    ray_from_sq ^ table[b]
}

// ---------------------------
// Angriffs-Masken
// ---------------------------
#[inline]
// Ermittelt Läufer-Angriffe von `sq` unter Berücksichtigung der Belegung.
// Verwendet Rays + Clipping für diagonale Richtungen.
fn bishop_attacks(sq: u8, occ: u64) -> u64 {
    let i = sq as usize;
    let ne = clip_forward(RAY_NE[i], occ & RAY_NE[i], &RAY_NE);
    let nw = clip_forward(RAY_NW[i], occ & RAY_NW[i], &RAY_NW);
    let se = clip_backward(RAY_SE[i], occ & RAY_SE[i], &RAY_SE);
    let sw = clip_backward(RAY_SW[i], occ & RAY_SW[i], &RAY_SW);
    ne | nw | se | sw
}

#[inline]
// Ermittelt Turm-Angriffe von `sq` unter Berücksichtigung der Belegung.
// Verwendet Rays + Clipping für horizontale/vertikale Richtungen.
fn rook_attacks(sq: u8, occ: u64) -> u64 {
    let i = sq as usize;
    let n = clip_forward(RAY_N[i], occ & RAY_N[i], &RAY_N);
    let e = clip_forward(RAY_E[i], occ & RAY_E[i], &RAY_E);
    let s = clip_backward(RAY_S[i], occ & RAY_S[i], &RAY_S);
    let w = clip_backward(RAY_W[i], occ & RAY_W[i], &RAY_W);
    n | e | s | w
}

#[inline]
// Ermittelt Damen-Angriffe als Kombination aus Läufer und Turm.
// Benötigt nur die Belegung des Boards.
fn queen_attacks(sq: u8, occ: u64) -> u64 {
    bishop_attacks(sq, occ) | rook_attacks(sq, occ)
}

#[inline]
// Wandelt ein Bitboard in eine Feldliste (0..63) um.
// Iteriert über die gesetzten Bits (LSB-Loop).
// Reihenfolge ist LSB -> MSB.
fn bitboard_to_vec(mut bb: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while bb != 0 {
        let lsb = bb & bb.wrapping_neg();
        let idx = lsb.trailing_zeros() as u8;
        out.push(idx);
        bb ^= lsb;
    }
    out
}

// ---------------------------
// Position / FEN
// ---------------------------
#[inline]
// Bestimmt die Farbe eines Pieces anhand der Groß-/Kleinschreibung.
// Großbuchstaben = Weiß, Kleinbuchstaben = Schwarz.
// Wird überall für Farblogik genutzt.
fn piece_color(ch: char) -> Color {
    if ch.is_ascii_uppercase() {
        Color::White
    } else {
        Color::Black
    }
}

// Erzeugt alle Bitboards aus dem Board-Array.
// Setzt zusätzlich die King-Squares für schnelle Schachprüfungen.
// Gibt None zurück, wenn ein König fehlt (ungültige Position).
fn build_bitboards(board: &[Option<char>; 64]) -> Option<Bitboards> {
    let mut bits = Bitboards {
        white_occ: 0,
        black_occ: 0,
        occ: 0,
        wp: 0,
        wn: 0,
        wb: 0,
        wr: 0,
        wq: 0,
        wk: 0,
        bp: 0,
        bn: 0,
        bb: 0,
        br: 0,
        bq: 0,
        bk: 0,
        white_king_sq: 64,
        black_king_sq: 64,
    };

    for (i, p) in board.iter().enumerate() {
        let Some(ch) = p else { continue };
        let sq = i as u8;
        let mask = bb(sq);
        match ch {
            'P' => { bits.wp |= mask; bits.white_occ |= mask; }
            'N' => { bits.wn |= mask; bits.white_occ |= mask; }
            'B' => { bits.wb |= mask; bits.white_occ |= mask; }
            'R' => { bits.wr |= mask; bits.white_occ |= mask; }
            'Q' => { bits.wq |= mask; bits.white_occ |= mask; }
            'K' => { bits.wk |= mask; bits.white_occ |= mask; bits.white_king_sq = sq; }
            'p' => { bits.bp |= mask; bits.black_occ |= mask; }
            'n' => { bits.bn |= mask; bits.black_occ |= mask; }
            'b' => { bits.bb |= mask; bits.black_occ |= mask; }
            'r' => { bits.br |= mask; bits.black_occ |= mask; }
            'q' => { bits.bq |= mask; bits.black_occ |= mask; }
            'k' => { bits.bk |= mask; bits.black_occ |= mask; bits.black_king_sq = sq; }
            _ => {}
        }
    }

    bits.occ = bits.white_occ | bits.black_occ;

    if bits.white_king_sq >= 64 || bits.black_king_sq >= 64 {
        return None;
    }

    Some(bits)
}

// Parst eine komplette FEN in unsere Position-Struktur.
// Erwartet mind. 4 Felder (Brett, Zugrecht, Rochade, En-passant).
// Halbzug/Vollzug werden mit Defaults versehen.
fn parse_fen(fen: &str) -> Option<Position> {
    let parts: Vec<&str> = fen.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }

    // Brett, Zugrecht, Rochade, En-passant, Halbzug, Vollzug
    let board = fen_board_to_array(parts[0])?;

    let side_to_move = match parts[1] {
        "w" => Color::White,
        "b" => Color::Black,
        _ => return None,
    };

    let castling = parse_castling(parts[2]);
    let ep = parse_ep(parts[3]);
    let halfmove = parts.get(4).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let fullmove = parts.get(5).and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);

    let bb = build_bitboards(&board)?;

    Some(Position {
        board,
        side_to_move,
        castling,
        ep,
        halfmove,
        fullmove,
        bb,
    })
}

// ---------------------------
// Angriffs- und Schachprüfung
// ---------------------------
// Prüft, ob ein Feld `sq` von der Farbe `by` angegriffen wird.
// Mischt Pawn-, Knight-, King- und Sliding-Angriffe.
// Wird für Schach, Rochade und Legalitätsprüfung verwendet.
fn is_square_attacked(pos: &Position, sq: u8, by: Color) -> bool {
    let occ = pos.bb.occ;
    let i = sq as usize;

    // Bauernangriffe über Bitboards
    let pawn_attacks = match by {
        Color::White => {
            ((pos.bb.wp & !FILE_H) << 9) | ((pos.bb.wp & !FILE_A) << 7)
        }
        Color::Black => {
            ((pos.bb.bp & !FILE_A) >> 9) | ((pos.bb.bp & !FILE_H) >> 7)
        }
    };
    if (pawn_attacks & bb(sq)) != 0 {
        return true;
    }

    // Springer
    let knights = match by {
        Color::White => pos.bb.wn,
        Color::Black => pos.bb.bn,
    };
    if (KNIGHT_ATTACKS[i] & knights) != 0 {
        return true;
    }

    // König
    let king = match by {
        Color::White => pos.bb.wk,
        Color::Black => pos.bb.bk,
    };
    if (KING_ATTACKS[i] & king) != 0 {
        return true;
    }

    // Läufer/Dame
    let bishops = match by {
        Color::White => pos.bb.wb | pos.bb.wq,
        Color::Black => pos.bb.bb | pos.bb.bq,
    };
    if (bishop_attacks(sq, occ) & bishops) != 0 {
        return true;
    }

    // Türme/Dame
    let rooks = match by {
        Color::White => pos.bb.wr | pos.bb.wq,
        Color::Black => pos.bb.br | pos.bb.bq,
    };
    if (rook_attacks(sq, occ) & rooks) != 0 {
        return true;
    }

    false
}

// Prüft, ob der König der gegebenen Farbe aktuell im Schach steht.
// Nutzt die vorab gespeicherte König-Position aus Bitboards.
fn is_in_check(pos: &Position, color: Color) -> bool {
    let king_sq = match color {
        Color::White => pos.bb.white_king_sq,
        Color::Black => pos.bb.black_king_sq,
    };
    is_square_attacked(pos, king_sq, color.opposite())
}

// ---------------------------
// Zugerzeugung (Pseudo + Legal)
// ---------------------------
// Fügt alle gesetzten Bits als Standardzüge hinzu.
// `from` ist das Startfeld der Figur, `bb` enthält Ziel-Felder.
// Spezialzüge (Rochade/EP/Promotion) werden separat behandelt.
fn push_moves_from_bb(moves: &mut Vec<Move>, from: u8, mut bb: u64) {
    while bb != 0 {
        let lsb = bb & bb.wrapping_neg();
        let idx = lsb.trailing_zeros() as u8;
        moves.push(Move { from, to: idx, kind: MoveKind::Normal });
        bb ^= lsb;
    }
}

// Prüft, ob eine kurze Rochade zulässig ist.
// Bedingungen: Rechte vorhanden, König/Turm korrekt, Felder frei,
// und keine der König-Durchlauf-Felder im Schach.
fn can_castle_kingside(pos: &Position, color: Color, from: u8) -> bool {
    match color {
        Color::White => {
            // König muss auf e1 stehen und Rochaderecht vorhanden
            if from != 4 { return false; }
            if (pos.castling & CASTLE_WK) == 0 { return false; }
            if pos.board[7] != Some('R') { return false; }
            if pos.board[5].is_some() || pos.board[6].is_some() { return false; }
            if is_square_attacked(pos, 4, Color::Black) { return false; }
            if is_square_attacked(pos, 5, Color::Black) { return false; }
            if is_square_attacked(pos, 6, Color::Black) { return false; }
            true
        }
        Color::Black => {
            // König muss auf e8 stehen und Rochaderecht vorhanden
            if from != 60 { return false; }
            if (pos.castling & CASTLE_BK) == 0 { return false; }
            if pos.board[63] != Some('r') { return false; }
            if pos.board[61].is_some() || pos.board[62].is_some() { return false; }
            if is_square_attacked(pos, 60, Color::White) { return false; }
            if is_square_attacked(pos, 61, Color::White) { return false; }
            if is_square_attacked(pos, 62, Color::White) { return false; }
            true
        }
    }
}

// Prüft, ob eine lange Rochade zulässig ist.
// Zusätzliche Bedingung: b-Feld darf belegt sein, aber nicht die Durchlauf-Felder.
// (Hier prüfen wir: b, c, d müssen leer sein).
fn can_castle_queenside(pos: &Position, color: Color, from: u8) -> bool {
    match color {
        Color::White => {
            // König muss auf e1 stehen und Rochaderecht vorhanden
            if from != 4 { return false; }
            if (pos.castling & CASTLE_WQ) == 0 { return false; }
            if pos.board[0] != Some('R') { return false; }
            if pos.board[1].is_some() || pos.board[2].is_some() || pos.board[3].is_some() { return false; }
            if is_square_attacked(pos, 4, Color::Black) { return false; }
            if is_square_attacked(pos, 3, Color::Black) { return false; }
            if is_square_attacked(pos, 2, Color::Black) { return false; }
            true
        }
        Color::Black => {
            // König muss auf e8 stehen und Rochaderecht vorhanden
            if from != 60 { return false; }
            if (pos.castling & CASTLE_BQ) == 0 { return false; }
            if pos.board[56] != Some('r') { return false; }
            if pos.board[57].is_some() || pos.board[58].is_some() || pos.board[59].is_some() { return false; }
            if is_square_attacked(pos, 60, Color::White) { return false; }
            if is_square_attacked(pos, 59, Color::White) { return false; }
            if is_square_attacked(pos, 58, Color::White) { return false; }
            true
        }
    }
}

// Erzeugt alle Bauern-Pseudozüge von einem Feld.
// Enthält Vorwärtszüge, Doppelzug, Schläge, Promotion und En-passant.
// Legalitätsprüfung passiert später.
fn gen_pawn_moves(pos: &Position, from: u8, color: Color, moves: &mut Vec<Move>) {
    let occ = pos.bb.occ;
    let from_i = from as i16;
    let file = (from % 8) as i16;
    let rank = (from / 8) as i16;

    let dir: i16 = match color {
        Color::White => 8,
        Color::Black => -8,
    };

    let promotion_rank: i16 = match color {
        Color::White => 7,
        Color::Black => 0,
    };

    // 1 Schritt vorwärts
    let one = from_i + dir;
    if one >= 0 && one < 64 {
        let one_sq = one as u8;
        if (occ & bb(one_sq)) == 0 {
            let one_rank = (one_sq / 8) as i16;
            let kind = if one_rank == promotion_rank { MoveKind::Promotion } else { MoveKind::Normal };
            moves.push(Move { from, to: one_sq, kind });

            // 2 Schritte (Startreihe)
            let start_rank = if color == Color::White { 1 } else { 6 };
            if rank == start_rank {
                let two = from_i + (dir * 2);
                if two >= 0 && two < 64 {
                    let two_sq = two as u8;
                    if (occ & bb(two_sq)) == 0 {
                        moves.push(Move { from, to: two_sq, kind: MoveKind::Normal });
                    }
                }
            }
        }
    }

    // Schlagen (Diagonalen)
    let (cap_left, cap_right) = match color {
        Color::White => (from_i + 7, from_i + 9),
        Color::Black => (from_i - 9, from_i - 7),
    };

    if file > 0 && cap_left >= 0 && cap_left < 64 {
        let cap_sq = cap_left as u8;
        let is_enemy = match color {
            Color::White => (pos.bb.black_occ & bb(cap_sq)) != 0,
            Color::Black => (pos.bb.white_occ & bb(cap_sq)) != 0,
        };
        if is_enemy {
            let cap_rank = (cap_sq / 8) as i16;
            let kind = if cap_rank == promotion_rank { MoveKind::Promotion } else { MoveKind::Normal };
            moves.push(Move { from, to: cap_sq, kind });
        }
    }

    if file < 7 && cap_right >= 0 && cap_right < 64 {
        let cap_sq = cap_right as u8;
        let is_enemy = match color {
            Color::White => (pos.bb.black_occ & bb(cap_sq)) != 0,
            Color::Black => (pos.bb.white_occ & bb(cap_sq)) != 0,
        };
        if is_enemy {
            let cap_rank = (cap_sq / 8) as i16;
            let kind = if cap_rank == promotion_rank { MoveKind::Promotion } else { MoveKind::Normal };
            moves.push(Move { from, to: cap_sq, kind });
        }
    }

    // En passant
    if let Some(ep_sq) = pos.ep {
        if ep_sq as i16 == cap_left || ep_sq as i16 == cap_right {
            let cap_field = if color == Color::White {
                (ep_sq as i16 - 8) as u8
            } else {
                (ep_sq as i16 + 8) as u8
            };
            let has_enemy_pawn = match color {
                Color::White => (pos.bb.bp & bb(cap_field)) != 0,
                Color::Black => (pos.bb.wp & bb(cap_field)) != 0,
            };
            if has_enemy_pawn {
                moves.push(Move { from, to: ep_sq, kind: MoveKind::EnPassant });
            }
        }
    }
}

// Erzeugt alle Pseudozüge einer Figur auf `from`.
// Filtert auf „side to move“ und ergänzt Rochade beim König.
// Legalitätsprüfung erfolgt separat.
fn generate_moves_for_piece(pos: &Position, from: u8) -> Vec<Move> {
    let mut moves = Vec::new();
    let idx = from as usize;
    let Some(piece) = pos.board[idx] else { return moves; };
    let color = piece_color(piece);

    // Nur Züge der Seite am Zug
    if color != pos.side_to_move {
        return moves;
    }

    let own_occ = match color {
        Color::White => pos.bb.white_occ,
        Color::Black => pos.bb.black_occ,
    };

    match piece.to_ascii_lowercase() {
        'p' => {
            gen_pawn_moves(pos, from, color, &mut moves);
        }
        'n' => {
            let attacks = KNIGHT_ATTACKS[idx] & !own_occ;
            push_moves_from_bb(&mut moves, from, attacks);
        }
        'b' => {
            let attacks = bishop_attacks(from, pos.bb.occ) & !own_occ;
            push_moves_from_bb(&mut moves, from, attacks);
        }
        'r' => {
            let attacks = rook_attacks(from, pos.bb.occ) & !own_occ;
            push_moves_from_bb(&mut moves, from, attacks);
        }
        'q' => {
            let attacks = queen_attacks(from, pos.bb.occ) & !own_occ;
            push_moves_from_bb(&mut moves, from, attacks);
        }
        'k' => {
            let attacks = KING_ATTACKS[idx] & !own_occ;
            push_moves_from_bb(&mut moves, from, attacks);

            if can_castle_kingside(pos, color, from) {
                let to = if color == Color::White { 6 } else { 62 };
                moves.push(Move { from, to, kind: MoveKind::Castle });
            }
            if can_castle_queenside(pos, color, from) {
                let to = if color == Color::White { 2 } else { 58 };
                moves.push(Move { from, to, kind: MoveKind::Castle });
            }
        }
        _ => {}
    }

    moves
}

// Wendet einen Zug direkt auf das Board an.
// Behandelt Sonderzüge (Rochade, En-passant, Promotion).
// Macht keine Legalitätsprüfung.
fn apply_move_to_board(board: &mut [Option<char>; 64], mv: Move, color: Color, promotion: Option<char>) {
    let from = mv.from as usize;
    let to = mv.to as usize;
    let Some(piece) = board[from] else { return; };

    // Board-Update ohne weitere Validierung
    match mv.kind {
        MoveKind::Normal => {
            board[to] = Some(piece);
            board[from] = None;
        }
        MoveKind::Promotion => {
            let promo = promotion.unwrap_or('q').to_ascii_lowercase();
            let mut placed = match promo {
                'q' | 'r' | 'b' | 'n' => promo,
                _ => 'q',
            };
            if piece.is_ascii_uppercase() {
                placed = placed.to_ascii_uppercase();
            }
            board[to] = Some(placed);
            board[from] = None;
        }
        MoveKind::EnPassant => {
            board[to] = Some(piece);
            board[from] = None;
            let cap_sq = if color == Color::White { mv.to - 8 } else { mv.to + 8 };
            board[cap_sq as usize] = None;
        }
        MoveKind::Castle => {
            board[to] = Some(piece);
            board[from] = None;

            if color == Color::White {
                if mv.to == 6 {
                    board[5] = board[7];
                    board[7] = None;
                } else if mv.to == 2 {
                    board[3] = board[0];
                    board[0] = None;
                }
            } else {
                if mv.to == 62 {
                    board[61] = board[63];
                    board[63] = None;
                } else if mv.to == 58 {
                    board[59] = board[56];
                    board[56] = None;
                }
            }
        }
    }
}

// Prüft die Legalität eines Zuges:
// Zug simulieren und sicherstellen, dass der eigene König nicht im Schach steht.
// Weitere Regeln (z.B. Rochade-Bedingungen) sind bereits im Pseudozug enthalten.
fn is_move_legal(pos: &Position, mv: Move, color: Color) -> bool {
    // Testzug ausführen und prüfen, ob eigener König danach im Schach steht
    let mut board = pos.board;
    apply_move_to_board(&mut board, mv, color, None);
    let Some(bb) = build_bitboards(&board) else { return false; };

    let test_pos = Position {
        board,
        side_to_move: pos.side_to_move,
        castling: pos.castling,
        ep: pos.ep,
        halfmove: pos.halfmove,
        fullmove: pos.fullmove,
        bb,
    };

    !is_in_check(&test_pos, color)
}

// Findet einen legalen Zug von `from` nach `to` (inkl. Sonderzugtyp).
// Wird für `apply_move` genutzt, damit nur gültige Züge übernommen werden.
fn find_legal_move(pos: &Position, from: u8, to: u8) -> Option<Move> {
    let moves = generate_moves_for_piece(pos, from);
    for mv in moves {
        if mv.to == to && is_move_legal(pos, mv, pos.side_to_move) {
            return Some(mv);
        }
    }
    None
}

// ---------------------------
// WASM Exports
// ---------------------------
// WASM-Export: liefert alle legalen Ziel-Felder für die Figur auf `field`.
// Berücksichtigt Schach, Rochade und En-passant.
// Gibt eine Liste von Feldindizes (0..63) zurück.
#[wasm_bindgen]
pub fn get_valid_moves(fen: &str, field: u8) -> Vec<u8> {
    // Liefert nur legale Ziele (inkl. Rochade/En-passant)
    let pos = match parse_fen(fen) {
        Some(p) => p,
        None => return Vec::new(),
    };

    if field >= 64 {
        return Vec::new();
    }

    let piece = match pos.board[field as usize] {
        Some(p) => p,
        None => return Vec::new(),
    };

    let color = piece_color(piece);
    if color != pos.side_to_move {
        return Vec::new();
    }

    let moves = generate_moves_for_piece(&pos, field);
    let mut legal = Vec::new();
    for mv in moves {
        if is_move_legal(&pos, mv, color) {
            legal.push(mv.to);
        }
    }
    legal
}

// WASM-Export: wendet einen legalen Zug an und gibt die neue FEN zurück.
// Prüft Legalität (inkl. Schach) und lehnt ungültige Züge ab.
// `promotion` ist optional (Q/R/B/N), Standard ist Queen.
#[wasm_bindgen]
pub fn apply_move(fen: &str, from: u8, to: u8, promotion: &str) -> String {
    // Illegaler Zug? -> ursprüngliche FEN zurückgeben
    let mut pos = match parse_fen(fen) {
        Some(p) => p,
        None => return fen.to_string(),
    };

    if from >= 64 || to >= 64 {
        return fen.to_string();
    }

    let mv = match find_legal_move(&pos, from, to) {
        Some(m) => m,
        None => return fen.to_string(),
    };

    let piece = match pos.board[from as usize] {
        Some(p) => p,
        None => return fen.to_string(),
    };

    let color = piece_color(piece);

    // Eventuell geschlagene Figur (inkl. En passant)
    let captured_piece = match mv.kind {
        MoveKind::EnPassant => {
            let cap_sq = if color == Color::White { to - 8 } else { to + 8 };
            pos.board[cap_sq as usize]
        }
        _ => pos.board[to as usize],
    };

    let promo_char = promotion.chars().next();
    apply_move_to_board(&mut pos.board, mv, color, promo_char);

    // Rochaderechte aktualisieren
    let mut castling = pos.castling;
    if piece.to_ascii_lowercase() == 'k' {
        if color == Color::White {
            castling &= !(CASTLE_WK | CASTLE_WQ);
        } else {
            castling &= !(CASTLE_BK | CASTLE_BQ);
        }
    }
    if piece.to_ascii_lowercase() == 'r' {
        match from {
            0 => castling &= !CASTLE_WQ,
            7 => castling &= !CASTLE_WK,
            56 => castling &= !CASTLE_BQ,
            63 => castling &= !CASTLE_BK,
            _ => {}
        }
    }
    if let Some(cap) = captured_piece {
        if cap.to_ascii_lowercase() == 'r' {
            match to {
                0 => castling &= !CASTLE_WQ,
                7 => castling &= !CASTLE_WK,
                56 => castling &= !CASTLE_BQ,
                63 => castling &= !CASTLE_BK,
                _ => {}
            }
        }
    }

    // En-passant Ziel aktualisieren
    let mut new_ep = None;
    if piece.to_ascii_lowercase() == 'p' {
        let from_rank = from / 8;
        let to_rank = to / 8;
        if color == Color::White && from_rank == 1 && to_rank == 3 {
            new_ep = Some(from + 8);
        } else if color == Color::Black && from_rank == 6 && to_rank == 4 {
            new_ep = Some(from - 8);
        }
    }

    // Halbzugzähler
    let mut halfmove = pos.halfmove;
    let is_capture = match mv.kind {
        MoveKind::EnPassant => true,
        _ => captured_piece.is_some(),
    };
    if piece.to_ascii_lowercase() == 'p' || is_capture {
        halfmove = 0;
    } else {
        halfmove += 1;
    }

    // Vollzugnummer
    let mut fullmove = pos.fullmove;
    if pos.side_to_move == Color::Black {
        fullmove += 1;
    }

    let new_board_part = board_to_fen(&pos.board);
    let new_side = if pos.side_to_move == Color::White { "b" } else { "w" };
    let new_castling = castling_to_string(castling);
    let new_ep_str = match new_ep {
        Some(sq) => field_to_lan(sq),
        None => "-".to_string(),
    };

    format!(
        "{} {} {} {} {} {}",
        new_board_part, new_side, new_castling, new_ep_str, halfmove, fullmove
    )
}

// ---------------------------
// FEN Helper
// ---------------------------
// Parst den Rochade-String der FEN in eine Bitmaske.
// Unterstützt KQkq oder "-" für keine Rechte.
fn parse_castling(s: &str) -> u8 {
    if s == "-" {
        return 0;
    }
    let mut mask = 0u8;
    for ch in s.chars() {
        match ch {
            'K' => mask |= CASTLE_WK,
            'Q' => mask |= CASTLE_WQ,
            'k' => mask |= CASTLE_BK,
            'q' => mask |= CASTLE_BQ,
            _ => {}
        }
    }
    mask
}

// Wandelt die Rochade-Bitmaske zurück in die FEN-Repräsentation.
// Gibt "-" aus, wenn keine Rechte vorhanden sind.
fn castling_to_string(mask: u8) -> String {
    if mask == 0 {
        return "-".to_string();
    }
    let mut out = String::new();
    if (mask & CASTLE_WK) != 0 { out.push('K'); }
    if (mask & CASTLE_WQ) != 0 { out.push('Q'); }
    if (mask & CASTLE_BK) != 0 { out.push('k'); }
    if (mask & CASTLE_BQ) != 0 { out.push('q'); }
    out
}

// Wandelt algebraische Notation (z.B. "e4") in Feldindex 0..63.
// Erwartet exakt zwei Zeichen und gültige Range.
fn lan_to_field(s: &str) -> Option<u8> {
    let bytes = s.as_bytes();
    if bytes.len() != 2 {
        return None;
    }
    let file = bytes[0] as char;
    let rank = bytes[1] as char;
    if !(file >= 'a' && file <= 'h') {
        return None;
    }
    if !(rank >= '1' && rank <= '8') {
        return None;
    }
    let file_idx = (file as u8 - b'a') as u8;
    let rank_idx = (rank as u8 - b'1') as u8;
    Some(rank_idx * 8 + file_idx)
}

// Wandelt Feldindex 0..63 in algebraische Notation (z.B. "e4").
// Nutzt a1=0, h8=63 Konvention.
fn field_to_lan(sq: u8) -> String {
    let file = (sq % 8) as u8;
    let rank = (sq / 8) as u8 + 1;
    let file_char = (b'a' + file) as char;
    format!("{}{}", file_char, rank)
}

// Parst das En-passant-Feld der FEN.
// "-" bedeutet: kein EP-Ziel vorhanden.
fn parse_ep(s: &str) -> Option<u8> {
    if s == "-" {
        return None;
    }
    lan_to_field(s)
}

// Parst nur den Brett-Teil der FEN in ein Array.
// a1 entspricht Index 0, h8 entspricht Index 63.
// Gibt None zurück bei ungültiger Struktur.
fn fen_board_to_array(board_part: &str) -> Option<[Option<char>; 64]> {
    let ranks: Vec<&str> = board_part.split('/').collect();
    if ranks.len() != 8 {
        return None;
    }

    let mut board: [Option<char>; 64] = [None; 64];
    let mut row: i8 = 7;

    for rank in ranks {
        let mut col: i8 = 0;
        for ch in rank.chars() {
            if ch.is_ascii_digit() {
                let n = ch.to_digit(10)? as i8;
                col += n;
            } else {
                if col < 0 || col > 7 {
                    return None;
                }
                let idx = (row as usize) * 8 + (col as usize);
                board[idx] = Some(ch);
                col += 1;
            }
        }
        if col != 8 {
            return None;
        }
        row -= 1;
    }

    Some(board)
}

// Serialisiert das Board-Array zurück in den Brett-Teil der FEN.
// Komprimiert leere Felder als Zahlen.
fn board_to_fen(board: &[Option<char>; 64]) -> String {
    let mut ranks = Vec::with_capacity(8);

    for row in (0..8).rev() {
        let mut empty = 0;
        let mut rank = String::new();
        for col in 0..8 {
            let idx = row * 8 + col;
            match board[idx] {
                Some(ch) => {
                    if empty > 0 {
                        rank.push_str(&empty.to_string());
                        empty = 0;
                    }
                    rank.push(ch);
                }
                None => {
                    empty += 1;
                }
            }
        }
        if empty > 0 {
            rank.push_str(&empty.to_string());
        }
        ranks.push(rank);
    }

    ranks.join("/")
}
