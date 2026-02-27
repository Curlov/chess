use wasm_bindgen::prelude::*;
use std::collections::HashMap;
use std::mem::size_of;
use std::cell::{Cell, RefCell};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn date_now() -> f64;
}

thread_local! {
    static ROOT_EVAL_DEBUG: Cell<bool> = Cell::new(false);
}

const TIME_CHECK_NODE_INTERVAL: u64 = 256;

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

#[inline]
fn popcnt(x: u64) -> i32 {
    x.count_ones() as i32
}

#[inline]
fn pop_lsb(bb: &mut u64) -> u8 {
    let lsb = *bb & bb.wrapping_neg();
    let idx = lsb.trailing_zeros() as u8;
    *bb ^= lsb;
    idx
}

#[inline]
fn mirror_sq(sq: u8) -> u8 {
    sq ^ 56
}

#[inline]
fn shift_east(bb: u64) -> u64 {
    (bb << 1) & !FILE_A
}

#[inline]
fn shift_west(bb: u64) -> u64 {
    (bb >> 1) & !FILE_H
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

const RANK_1: u64 = 0x0000_0000_0000_00FF;
const RANK_2: u64 = 0x0000_0000_0000_FF00;
const RANK_3: u64 = 0x0000_0000_00FF_0000;
const RANK_4: u64 = 0x0000_0000_FF00_0000;
const RANK_5: u64 = 0x0000_00FF_0000_0000;
const RANK_6: u64 = 0x0000_FF00_0000_0000;
const RANK_7: u64 = 0x00FF_0000_0000_0000;
const RANK_8: u64 = 0xFF00_0000_0000_0000;

const fn build_file_masks() -> [u64; 8] {
    let mut a = [0u64; 8];
    let mut f = 0;
    while f < 8 {
        a[f] = FILE_A << f;
        f += 1;
    }
    a
}

const fn build_adj_file_masks() -> [u64; 8] {
    let mut a = [0u64; 8];
    let mut f = 0;
    while f < 8 {
        let mut mask = 0u64;
        if f > 0 {
            mask |= FILE_A << (f - 1);
        }
        if f < 7 {
            mask |= FILE_A << (f + 1);
        }
        a[f] = mask;
        f += 1;
    }
    a
}

const FILE_MASKS: [u64; 8] = build_file_masks();
const ADJ_FILE_MASKS: [u64; 8] = build_adj_file_masks();

const fn build_passed_masks_white() -> [u64; 64] {
    let mut a = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let file = (sq % 8) as i8;
        let rank = (sq / 8) as i8;
        let mut mask = 0u64;
        let mut r = rank + 1;
        while r <= 7 {
            let mut f = file - 1;
            while f <= file + 1 {
                if f >= 0 && f <= 7 {
                    let idx = (r as u8) * 8 + (f as u8);
                    mask |= 1u64 << idx;
                }
                f += 1;
            }
            r += 1;
        }
        a[sq as usize] = mask;
        sq += 1;
    }
    a
}

const fn build_passed_masks_black() -> [u64; 64] {
    let mut a = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let file = (sq % 8) as i8;
        let rank = (sq / 8) as i8;
        let mut mask = 0u64;
        let mut r = rank - 1;
        while r >= 0 {
            let mut f = file - 1;
            while f <= file + 1 {
                if f >= 0 && f <= 7 {
                    let idx = (r as u8) * 8 + (f as u8);
                    mask |= 1u64 << idx;
                }
                f += 1;
            }
            r -= 1;
        }
        a[sq as usize] = mask;
        sq += 1;
    }
    a
}

const PASSED_MASKS_WHITE: [u64; 64] = build_passed_masks_white();
const PASSED_MASKS_BLACK: [u64; 64] = build_passed_masks_black();

const fn build_king_zone() -> [u64; 64] {
    let mut a = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let mut zone = KING_ATTACKS[sq] | (1u64 << sq);
        let ring = KING_ATTACKS[sq];
        let mut i = 0;
        while i < 64 {
            if ((ring >> i) & 1) != 0 {
                zone |= KING_ATTACKS[i];
            }
            i += 1;
        }
        a[sq] = zone;
        sq += 1;
    }
    a
}

const KING_ZONE: [u64; 64] = build_king_zone();

const CASTLE_WK: u8 = 1;
const CASTLE_WQ: u8 = 2;
const CASTLE_BK: u8 = 4;
const CASTLE_BQ: u8 = 8;
const MATE_SCORE: i32 = 30000;
const MATE_THRESHOLD: i32 = 29000;
const MATE_EARLY_STOP_PLIES: i32 = 10;
const INF_SCORE: i32 = 32000;
const MAX_PHASE: i32 = 24;

#[inline]
fn mate_score(ply: i32) -> i32 {
    MATE_SCORE - ply
}

#[inline]
fn is_mate_score(score: i32) -> bool {
    score.abs() >= MATE_THRESHOLD
}

#[inline]
fn clamp_eval(score: i32) -> i32 {
    score.max(-MATE_THRESHOLD + 1).min(MATE_THRESHOLD - 1)
}

#[inline]
fn tt_store_score(score: i32, ply: i32) -> i32 {
    if score >= MATE_THRESHOLD {
        score + ply
    } else if score <= -MATE_THRESHOLD {
        score - ply
    } else {
        score
    }
}

#[inline]
fn tt_probe_score(score: i32, ply: i32) -> i32 {
    if score >= MATE_THRESHOLD {
        score - ply
    } else if score <= -MATE_THRESHOLD {
        score + ply
    } else {
        score
    }
}

// ---------------------------
// Eval: Material + PST (MG/EG)
// ---------------------------
const MG_VALUES: [i32; 6] = [100, 320, 330, 500, 900, 0];
const EG_VALUES: [i32; 6] = [120, 300, 320, 510, 900, 0];
const PHASE_VALUES: [i32; 6] = [0, 1, 1, 2, 4, 0];

const MG_PST_PAWN: [i32; 64] = [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10,-10,-10, 10, 10,  5,
     5,  5, 10, 15, 15, 10,  5,  5,
     0,  0, 10, 20, 20, 10,  0,  0,
     5,  5, 10, 25, 25, 10,  5,  5,
    10, 10, 20, 30, 30, 20, 10, 10,
    50, 50, 50, 50, 50, 50, 50, 50,
     0,  0,  0,  0,  0,  0,  0,  0,
];

const EG_PST_PAWN: [i32; 64] = [
     0,  0,  0,  0,  0,  0,  0,  0,
     0,  0,  0,  0,  0,  0,  0,  0,
     5,  5,  5,  5,  5,  5,  5,  5,
    10, 10, 10, 10, 10, 10, 10, 10,
    20, 20, 20, 20, 20, 20, 20, 20,
    40, 40, 40, 40, 40, 40, 40, 40,
    70, 70, 70, 70, 70, 70, 70, 70,
     0,  0,  0,  0,  0,  0,  0,  0,
];

const MG_PST_KNIGHT: [i32; 64] = [
   -50,-40,-30,-30,-30,-30,-40,-50,
   -40,-20,  0,  0,  0,  0,-20,-40,
   -30,  0, 10, 15, 15, 10,  0,-30,
   -30,  5, 15, 20, 20, 15,  5,-30,
   -30,  0, 15, 20, 20, 15,  0,-30,
   -30,  5, 10, 15, 15, 10,  5,-30,
   -40,-20,  0,  5,  5,  0,-20,-40,
   -50,-40,-30,-30,-30,-30,-40,-50,
];

const EG_PST_KNIGHT: [i32; 64] = [
   -40,-30,-20,-20,-20,-20,-30,-40,
   -30,-10,  0,  0,  0,  0,-10,-30,
   -20,  0, 10, 10, 10, 10,  0,-20,
   -20,  5, 10, 15, 15, 10,  5,-20,
   -20,  0, 10, 15, 15, 10,  0,-20,
   -20,  5, 10, 10, 10, 10,  5,-20,
   -30,-10,  0,  5,  5,  0,-10,-30,
   -40,-30,-20,-20,-20,-20,-30,-40,
];

const MG_PST_BISHOP: [i32; 64] = [
   -20,-10,-10,-10,-10,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5, 10, 10,  5,  0,-10,
   -10,  5,  5, 10, 10,  5,  5,-10,
   -10,  0, 10, 10, 10, 10,  0,-10,
   -10, 10, 10, 10, 10, 10, 10,-10,
   -10,  5,  0,  0,  0,  0,  5,-10,
   -20,-10,-10,-10,-10,-10,-10,-20,
];

const EG_PST_BISHOP: [i32; 64] = [
   -10, -5, -5, -5, -5, -5, -5,-10,
    -5,  5,  0,  0,  0,  0,  5, -5,
    -5,  0, 10, 10, 10, 10,  0, -5,
    -5,  5, 10, 15, 15, 10,  5, -5,
    -5,  0, 10, 15, 15, 10,  0, -5,
    -5,  5, 10, 10, 10, 10,  5, -5,
    -5,  5,  0,  0,  0,  0,  5, -5,
   -10, -5, -5, -5, -5, -5, -5,-10,
];

const MG_PST_ROOK: [i32; 64] = [
     0,  0,  5, 10, 10,  5,  0,  0,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     5, 10, 10, 10, 10, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
];

const EG_PST_ROOK: [i32; 64] = [
     0,  0,  5, 10, 10,  5,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
     0,  0,  5,  5,  5,  5,  0,  0,
     0,  0,  5,  5,  5,  5,  0,  0,
     0,  0,  5,  5,  5,  5,  0,  0,
     0,  0,  5,  5,  5,  5,  0,  0,
     0,  0,  5, 10, 10,  5,  0,  0,
     0,  0,  0,  0,  0,  0,  0,  0,
];

const MG_PST_QUEEN: [i32; 64] = [
   -20,-10,-10, -5, -5,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5,  5,  5,  5,  0,-10,
    -5,  0,  5,  5,  5,  5,  0, -5,
     0,  0,  5,  5,  5,  5,  0, -5,
   -10,  5,  5,  5,  5,  5,  0,-10,
   -10,  0,  5,  0,  0,  0,  0,-10,
   -20,-10,-10, -5, -5,-10,-10,-20,
];

const EG_PST_QUEEN: [i32; 64] = [
   -10, -5, -5, -5, -5, -5, -5,-10,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  5,  5,  5,  5,  0, -5,
    -5,  0,  5,  5,  5,  5,  0, -5,
    -5,  0,  5,  5,  5,  5,  0, -5,
    -5,  0,  5,  5,  5,  5,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
   -10, -5, -5, -5, -5, -5, -5,-10,
];

const MG_PST_KING: [i32; 64] = [
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -40,-50,-50,-60,-60,-50,-50,-40,
   -50,-60,-60,-70,-70,-60,-60,-50,
   -50,-60,-60,-70,-70,-60,-60,-50,
   -40,-50,-50,-60,-60,-50,-50,-40,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
];

const EG_PST_KING: [i32; 64] = [
   -10, -5,  0,  5,  5,  0, -5,-10,
    -5,  5, 10, 15, 15, 10,  5, -5,
     0, 10, 20, 25, 25, 20, 10,  0,
     5, 15, 25, 30, 30, 25, 15,  5,
     5, 15, 25, 30, 30, 25, 15,  5,
     0, 10, 20, 25, 25, 20, 10,  0,
    -5,  5, 10, 15, 15, 10,  5, -5,
   -10, -5,  0,  5,  5,  0, -5,-10,
];

const MG_PST: [[i32; 64]; 6] = [
    MG_PST_PAWN,
    MG_PST_KNIGHT,
    MG_PST_BISHOP,
    MG_PST_ROOK,
    MG_PST_QUEEN,
    MG_PST_KING,
];

const EG_PST: [[i32; 64]; 6] = [
    EG_PST_PAWN,
    EG_PST_KNIGHT,
    EG_PST_BISHOP,
    EG_PST_ROOK,
    EG_PST_QUEEN,
    EG_PST_KING,
];

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

#[derive(Copy, Clone, PartialEq, Eq)]
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
#[derive(Copy, Clone)]
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

#[inline]
fn remove_piece(bits: &mut Bitboards, piece: char, sq: u8) {
    let mask = bb(sq);
    match piece {
        'P' => bits.wp &= !mask,
        'N' => bits.wn &= !mask,
        'B' => bits.wb &= !mask,
        'R' => bits.wr &= !mask,
        'Q' => bits.wq &= !mask,
        'K' => bits.wk &= !mask,
        'p' => bits.bp &= !mask,
        'n' => bits.bn &= !mask,
        'b' => bits.bb &= !mask,
        'r' => bits.br &= !mask,
        'q' => bits.bq &= !mask,
        'k' => bits.bk &= !mask,
        _ => {}
    }
    if piece.is_ascii_uppercase() {
        bits.white_occ &= !mask;
    } else {
        bits.black_occ &= !mask;
    }
    bits.occ &= !mask;
}

#[inline]
fn add_piece(bits: &mut Bitboards, piece: char, sq: u8) {
    let mask = bb(sq);
    match piece {
        'P' => bits.wp |= mask,
        'N' => bits.wn |= mask,
        'B' => bits.wb |= mask,
        'R' => bits.wr |= mask,
        'Q' => bits.wq |= mask,
        'K' => { bits.wk |= mask; bits.white_king_sq = sq; },
        'p' => bits.bp |= mask,
        'n' => bits.bn |= mask,
        'b' => bits.bb |= mask,
        'r' => bits.br |= mask,
        'q' => bits.bq |= mask,
        'k' => { bits.bk |= mask; bits.black_king_sq = sq; },
        _ => {}
    }
    if piece.is_ascii_uppercase() {
        bits.white_occ |= mask;
    } else {
        bits.black_occ |= mask;
    }
    bits.occ |= mask;
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

#[inline]
fn clone_position(pos: &Position) -> Position {
    Position {
        board: pos.board,
        side_to_move: pos.side_to_move,
        castling: pos.castling,
        ep: pos.ep,
        halfmove: pos.halfmove,
        fullmove: pos.fullmove,
        bb: pos.bb,
    }
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

    // En passant (nur wenn Datei-Grenzen passen, kein Wrap-around)
    if let Some(ep_sq) = pos.ep {
        let mut allow = false;
        if file > 0 && ep_sq as i16 == cap_left {
            allow = true;
        } else if file < 7 && ep_sq as i16 == cap_right {
            allow = true;
        }

        if allow {
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

// Erzeugt alle Pseudozüge einer Figur auf `from` in `out`.
// Filtert auf „side to move“ und ergänzt Rochade beim König.
// Legalitätsprüfung erfolgt separat.
fn generate_moves_for_piece_into(pos: &Position, from: u8, out: &mut Vec<Move>) {
    out.clear();
    let idx = from as usize;
    let Some(piece) = pos.board[idx] else { return; };
    let color = piece_color(piece);

    // Nur Züge der Seite am Zug
    if color != pos.side_to_move {
        return;
    }

    let own_occ = match color {
        Color::White => pos.bb.white_occ,
        Color::Black => pos.bb.black_occ,
    };

    match piece.to_ascii_lowercase() {
        'p' => {
            gen_pawn_moves(pos, from, color, out);
        }
        'n' => {
            let attacks = KNIGHT_ATTACKS[idx] & !own_occ;
            push_moves_from_bb(out, from, attacks);
        }
        'b' => {
            let attacks = bishop_attacks(from, pos.bb.occ) & !own_occ;
            push_moves_from_bb(out, from, attacks);
        }
        'r' => {
            let attacks = rook_attacks(from, pos.bb.occ) & !own_occ;
            push_moves_from_bb(out, from, attacks);
        }
        'q' => {
            let attacks = queen_attacks(from, pos.bb.occ) & !own_occ;
            push_moves_from_bb(out, from, attacks);
        }
        'k' => {
            let attacks = KING_ATTACKS[idx] & !own_occ;
            push_moves_from_bb(out, from, attacks);

            if can_castle_kingside(pos, color, from) {
                let to = if color == Color::White { 6 } else { 62 };
                out.push(Move { from, to, kind: MoveKind::Castle });
            }
            if can_castle_queenside(pos, color, from) {
                let to = if color == Color::White { 2 } else { 58 };
                out.push(Move { from, to, kind: MoveKind::Castle });
            }
        }
        _ => {}
    }
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
fn is_move_legal(pos: &mut Position, mv: Move, color: Color) -> bool {
    if color != pos.side_to_move {
        return false;
    }
    let Some(undo) = make_move_in_place(pos, mv, None) else { return false; };
    let in_check = is_in_check(pos, color);
    unmake_move_in_place(pos, mv, None, undo);
    !in_check
}

// Findet einen legalen Zug von `from` nach `to` (inkl. Sonderzugtyp).
// Wird für `apply_move` genutzt, damit nur gültige Züge übernommen werden.
fn find_legal_move(pos: &mut Position, from: u8, to: u8) -> Option<Move> {
    let mut moves: Vec<Move> = Vec::with_capacity(32);
    generate_moves_for_piece_into(pos, from, &mut moves);
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
#[wasm_bindgen]
pub fn set_root_eval_debug(flag: bool) {
    ROOT_EVAL_DEBUG.with(|v| v.set(flag));
}

// WASM-Export: liefert alle legalen Ziel-Felder für die Figur auf `field`.
// Berücksichtigt Schach, Rochade und En-passant.
// Gibt eine Liste von Feldindizes (0..63) zurück.
#[wasm_bindgen]
pub fn get_valid_moves(fen: &str, field: u8) -> Vec<u8> {
    // Liefert nur legale Ziele (inkl. Rochade/En-passant)
    let mut pos = match parse_fen(fen) {
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

    let mut moves: Vec<Move> = Vec::with_capacity(32);
    generate_moves_for_piece_into(&pos, field, &mut moves);
    let mut legal = Vec::new();
    for mv in moves {
        if is_move_legal(&mut pos, mv, color) {
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

    let mv = match find_legal_move(&mut pos, from, to) {
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
// Search (einfaches Alpha-Beta)
// ---------------------------
#[inline]
fn now_ms() -> f64 {
    date_now()
}

fn piece_value(piece: char) -> i32 {
    match piece.to_ascii_lowercase() {
        'p' => 100,
        'n' => 320,
        'b' => 330,
        'r' => 500,
        'q' => 900,
        'k' => 0,
        _ => 0,
    }
}

fn blend(mg: i32, eg: i32, phase: i32) -> i32 {
    (mg * phase + eg * (MAX_PHASE - phase)) / MAX_PHASE
}

fn compute_phase(pos: &Position) -> i32 {
    let mut phase = 0;
    phase += popcnt(pos.bb.wn) * PHASE_VALUES[1];
    phase += popcnt(pos.bb.bn) * PHASE_VALUES[1];
    phase += popcnt(pos.bb.wb) * PHASE_VALUES[2];
    phase += popcnt(pos.bb.bb) * PHASE_VALUES[2];
    phase += popcnt(pos.bb.wr) * PHASE_VALUES[3];
    phase += popcnt(pos.bb.br) * PHASE_VALUES[3];
    phase += popcnt(pos.bb.wq) * PHASE_VALUES[4];
    phase += popcnt(pos.bb.bq) * PHASE_VALUES[4];
    if phase > MAX_PHASE { MAX_PHASE } else { phase }
}

fn add_piece_scores(
    material_mg: &mut i32,
    material_eg: &mut i32,
    pst_mg: &mut i32,
    pst_eg: &mut i32,
    mut bb: u64,
    piece_idx: usize,
    is_white: bool,
) {
    let sign = if is_white { 1 } else { -1 };
    while bb != 0 {
        let sq = pop_lsb(&mut bb);
        let psq = if is_white { sq } else { mirror_sq(sq) };
        *material_mg += sign * MG_VALUES[piece_idx];
        *material_eg += sign * EG_VALUES[piece_idx];
        *pst_mg += sign * MG_PST[piece_idx][psq as usize];
        *pst_eg += sign * EG_PST[piece_idx][psq as usize];
    }
}

const DOUBLED_PAWN_MG: i32 = -12;
const DOUBLED_PAWN_EG: i32 = -8;
const ISOLATED_PAWN_MG: i32 = -15;
const ISOLATED_PAWN_EG: i32 = -10;
const CONNECTED_PASSED_MG: i32 = 8;
const CONNECTED_PASSED_EG: i32 = 15;
const SPACE_PAWN_MG: i32 = 5;

const PASSED_BONUS_MG: [i32; 8] = [0, 5, 10, 20, 30, 40, 60, 0];
const PASSED_BONUS_EG: [i32; 8] = [0, 10, 20, 40, 60, 80, 120, 0];

fn pawn_features(pos: &Position, color: Color) -> (i32, i32) {
    let pawns = if color == Color::White { pos.bb.wp } else { pos.bb.bp };
    let enemy_pawns = if color == Color::White { pos.bb.bp } else { pos.bb.wp };

    let mut mg = 0;
    let mut eg = 0;

    // Doubled / isolated
    for file in 0..8 {
        let file_mask = FILE_MASKS[file];
        let pawns_on_file = pawns & file_mask;
        let count = popcnt(pawns_on_file);
        if count > 1 {
            let extra = count - 1;
            mg += extra * DOUBLED_PAWN_MG;
            eg += extra * DOUBLED_PAWN_EG;
        }
        if pawns_on_file != 0 {
            let adj = pawns & ADJ_FILE_MASKS[file];
            if adj == 0 {
                mg += count * ISOLATED_PAWN_MG;
                eg += count * ISOLATED_PAWN_EG;
            }
        }
    }

    // Passed pawns + connected passed
    let mut passed = 0u64;
    let mut pawns_bb = pawns;
    while pawns_bb != 0 {
        let sq = pop_lsb(&mut pawns_bb);
        let mask = if color == Color::White {
            PASSED_MASKS_WHITE[sq as usize]
        } else {
            PASSED_MASKS_BLACK[sq as usize]
        };
        if (enemy_pawns & mask) == 0 {
            passed |= bb(sq);
            let rank = (sq / 8) as i32;
            let r = if color == Color::White { rank } else { 7 - rank };
            let idx = r.max(0).min(7) as usize;
            mg += PASSED_BONUS_MG[idx];
            eg += PASSED_BONUS_EG[idx];
        }
    }

    let connected = passed & (shift_east(passed) | shift_west(passed));
    let connected_count = popcnt(connected);
    mg += connected_count * CONNECTED_PASSED_MG;
    eg += connected_count * CONNECTED_PASSED_EG;

    // Space bonus (small, MG only)
    let space_mask = if color == Color::White { RANK_5 | RANK_6 } else { RANK_4 | RANK_3 };
    let space_count = popcnt(pawns & space_mask);
    mg += space_count * SPACE_PAWN_MG;

    (mg, eg)
}

fn pawn_structure_score(pos: &Position) -> (i32, i32) {
    let (w_mg, w_eg) = pawn_features(pos, Color::White);
    let (b_mg, b_eg) = pawn_features(pos, Color::Black);
    (w_mg - b_mg, w_eg - b_eg)
}

const KING_PRESSURE_MG: i32 = 8;
const KING_PRESSURE_EG: i32 = 3;
const PAWN_SHIELD_MG: i32 = 12;
const PAWN_SHIELD_EG: i32 = 4;
const PAWN_FILE_HALF_OPEN_MG: i32 = 6;
const PAWN_FILE_OPEN_MG: i32 = 10;

fn attacks_for_color(pos: &Position, color: Color) -> u64 {
    let occ = pos.bb.occ;
    let (pawns, knights, bishops, rooks, queens, king_sq) = match color {
        Color::White => (pos.bb.wp, pos.bb.wn, pos.bb.wb, pos.bb.wr, pos.bb.wq, pos.bb.white_king_sq),
        Color::Black => (pos.bb.bp, pos.bb.bn, pos.bb.bb, pos.bb.br, pos.bb.bq, pos.bb.black_king_sq),
    };

    let pawn_attacks = match color {
        Color::White => ((pawns & !FILE_H) << 9) | ((pawns & !FILE_A) << 7),
        Color::Black => ((pawns & !FILE_A) >> 9) | ((pawns & !FILE_H) >> 7),
    };

    let mut attacks = pawn_attacks | KING_ATTACKS[king_sq as usize];

    let mut bb = knights;
    while bb != 0 {
        let sq = pop_lsb(&mut bb) as usize;
        attacks |= KNIGHT_ATTACKS[sq];
    }

    let mut bb = bishops;
    while bb != 0 {
        let sq = pop_lsb(&mut bb);
        attacks |= bishop_attacks(sq, occ);
    }

    let mut bb = rooks;
    while bb != 0 {
        let sq = pop_lsb(&mut bb);
        attacks |= rook_attacks(sq, occ);
    }

    let mut bb = queens;
    while bb != 0 {
        let sq = pop_lsb(&mut bb);
        attacks |= queen_attacks(sq, occ);
    }

    attacks
}

fn king_safety_for(pos: &Position, color: Color) -> (i32, i32) {
    let king_sq = if color == Color::White { pos.bb.white_king_sq } else { pos.bb.black_king_sq };
    let enemy_attacks = attacks_for_color(pos, color.opposite());
    let pressure = popcnt(enemy_attacks & KING_ZONE[king_sq as usize]);
    let mut mg = -pressure * KING_PRESSURE_MG;
    let mut eg = -pressure * KING_PRESSURE_EG;

    // Pawn shield
    let pawns = if color == Color::White { pos.bb.wp } else { pos.bb.bp };
    let enemy_pawns = if color == Color::White { pos.bb.bp } else { pos.bb.wp };
    let file = (king_sq % 8) as usize;
    let shield_files = FILE_MASKS[file] | ADJ_FILE_MASKS[file];
    let shield_ranks = if color == Color::White { RANK_2 | RANK_3 } else { RANK_7 | RANK_6 };
    let shield_mask = shield_files & shield_ranks;
    let expected = if file == 0 || file == 7 { 2 } else { 3 };
    let shield_count = popcnt(pawns & shield_mask);
    let missing = expected - shield_count;
    if missing > 0 {
        mg -= missing * PAWN_SHIELD_MG;
        eg -= missing * PAWN_SHIELD_EG;
    }

    // Open / half-open files near king
    for df in [-1i32, 0, 1] {
        let f = file as i32 + df;
        if f < 0 || f > 7 {
            continue;
        }
        let fmask = FILE_MASKS[f as usize];
        if (pawns & fmask) == 0 {
            if (enemy_pawns & fmask) == 0 {
                mg -= PAWN_FILE_OPEN_MG;
            } else {
                mg -= PAWN_FILE_HALF_OPEN_MG;
            }
        }
    }

    (mg, eg)
}

fn king_safety_score(pos: &Position) -> (i32, i32) {
    let (w_mg, w_eg) = king_safety_for(pos, Color::White);
    let (b_mg, b_eg) = king_safety_for(pos, Color::Black);
    (w_mg - b_mg, w_eg - b_eg)
}

#[derive(Copy, Clone)]
struct EvalBreakdown {
    material: i32,
    pst: i32,
    pawn: i32,
    king: i32,
    misc: i32,
    total: i32,
}

fn negate_breakdown(bd: EvalBreakdown) -> EvalBreakdown {
    EvalBreakdown {
        material: -bd.material,
        pst: -bd.pst,
        pawn: -bd.pawn,
        king: -bd.king,
        misc: -bd.misc,
        total: -bd.total,
    }
}

fn evaluate_breakdown(pos: &Position) -> EvalBreakdown {
    let mut material_mg = 0;
    let mut material_eg = 0;
    let mut pst_mg = 0;
    let mut pst_eg = 0;

    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wp, 0, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wn, 1, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wb, 2, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wr, 3, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wq, 4, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wk, 5, true);

    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bp, 0, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bn, 1, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bb, 2, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.br, 3, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bq, 4, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bk, 5, false);

    let (pawn_mg, pawn_eg) = pawn_structure_score(pos);
    let (king_mg, king_eg) = king_safety_score(pos);

    let phase = compute_phase(pos);
    let material = blend(material_mg, material_eg, phase);
    let pst = blend(pst_mg, pst_eg, phase);
    let pawn = blend(pawn_mg, pawn_eg, phase);
    let king = blend(king_mg, king_eg, phase);
    let misc = 0;

    let mut total = material + pst + pawn + king + misc;
    let sign = if pos.side_to_move == Color::White { 1 } else { -1 };
    total *= sign;

    EvalBreakdown {
        material: material * sign,
        pst: pst * sign,
        pawn: pawn * sign,
        king: king * sign,
        misc: misc * sign,
        total,
    }
}

fn evaluate_fast(pos: &Position) -> i32 {
    let mut material_mg = 0;
    let mut material_eg = 0;
    let mut pst_mg = 0;
    let mut pst_eg = 0;

    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wp, 0, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wn, 1, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wb, 2, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wr, 3, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wq, 4, true);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.wk, 5, true);

    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bp, 0, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bn, 1, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bb, 2, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.br, 3, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bq, 4, false);
    add_piece_scores(&mut material_mg, &mut material_eg, &mut pst_mg, &mut pst_eg, pos.bb.bk, 5, false);

    let phase = compute_phase(pos);
    let material = blend(material_mg, material_eg, phase);
    let pst = blend(pst_mg, pst_eg, phase);

    let mut total = material + pst;
    let sign = if pos.side_to_move == Color::White { 1 } else { -1 };
    total *= sign;
    total
}

fn evaluate(pos: &Position) -> i32 {
    evaluate_breakdown(pos).total
}

fn root_eval_breakdown_json(pos: &mut Position) -> String {
    let mut moves = Vec::new();
    generate_legal_moves_into(pos, &mut moves);

    let mut out = String::new();
    out.push('[');
    let mut first = true;

    for (mv, promo) in moves.iter().copied() {
        let Some(undo) = make_move_in_place(pos, mv, promo) else { continue; };
        let bd = negate_breakdown(evaluate_breakdown(pos));
        unmake_move_in_place(pos, mv, promo, undo);

        if !first {
            out.push(',');
        }
        first = false;

        let uci = move_to_uci(mv, promo);
        out.push_str(&format!(
            "{{\"move\":\"{}\",\"total\":{},\"material\":{},\"pst\":{},\"pawn\":{},\"king\":{},\"misc\":{}}}",
            uci, bd.total, bd.material, bd.pst, bd.pawn, bd.king, bd.misc
        ));
    }

    out.push(']');
    out
}

fn generate_legal_moves_into(pos: &mut Position, out: &mut Vec<(Move, Option<char>)>) {
    out.clear();
    let mut piece_moves: Vec<Move> = Vec::with_capacity(32);
    for from in 0u8..64u8 {
        generate_moves_for_piece_into(pos, from, &mut piece_moves);
        for mv in piece_moves.iter().copied() {
            if is_move_legal(pos, mv, pos.side_to_move) {
                if let MoveKind::Promotion = mv.kind {
                    for promo in ['q', 'r', 'b', 'n'] {
                        out.push((mv, Some(promo)));
                    }
                } else {
                    out.push((mv, None));
                }
            }
        }
    }
}

fn generate_legal_moves(pos: &mut Position) -> Vec<(Move, Option<char>)> {
    let mut out = Vec::new();
    generate_legal_moves_into(pos, &mut out);
    out
}

fn apply_move_to_position(
    pos: &Position,
    mv: Move,
    promotion: Option<char>,
    hash: u64,
    zob: &Zobrist,
) -> Option<(Position, u64)> {
    let mut board = pos.board;
    let piece = board[mv.from as usize]?;
    let color = piece_color(piece);
    if color != pos.side_to_move {
        return None;
    }

    let mut cap_sq = None;
    let captured_piece = match mv.kind {
        MoveKind::EnPassant => {
            let sq = if color == Color::White { mv.to - 8 } else { mv.to + 8 };
            cap_sq = Some(sq);
            board[sq as usize]
        }
        _ => {
            let cap = board[mv.to as usize];
            if cap.is_some() {
                cap_sq = Some(mv.to);
            }
            cap
        }
    };

    let mut placed = piece;
    if let MoveKind::Promotion = mv.kind {
        let promo = promotion.unwrap_or('q').to_ascii_lowercase();
        let mut placed_piece = match promo {
            'q' | 'r' | 'b' | 'n' => promo,
            _ => 'q',
        };
        if piece.is_ascii_uppercase() {
            placed_piece = placed_piece.to_ascii_uppercase();
        }
        placed = placed_piece;
    }

    let mut bb = pos.bb;
    remove_piece(&mut bb, piece, mv.from);
    if let (Some(cap), Some(sq)) = (captured_piece, cap_sq) {
        remove_piece(&mut bb, cap, sq);
    }

    apply_move_to_board(&mut board, mv, color, promotion);
    add_piece(&mut bb, placed, mv.to);

    if mv.kind == MoveKind::Castle {
        let (rook_from, rook_to) = if color == Color::White {
            if mv.to == 6 { (7u8, 5u8) } else { (0u8, 3u8) }
        } else {
            if mv.to == 62 { (63u8, 61u8) } else { (56u8, 59u8) }
        };
        let rook_piece = if color == Color::White { 'R' } else { 'r' };
        remove_piece(&mut bb, rook_piece, rook_from);
        add_piece(&mut bb, rook_piece, rook_to);
    }

    let mut castling = pos.castling;
    if piece.to_ascii_lowercase() == 'k' {
        if color == Color::White {
            castling &= !(CASTLE_WK | CASTLE_WQ);
        } else {
            castling &= !(CASTLE_BK | CASTLE_BQ);
        }
    }
    if piece.to_ascii_lowercase() == 'r' {
        match mv.from {
            0 => castling &= !CASTLE_WQ,
            7 => castling &= !CASTLE_WK,
            56 => castling &= !CASTLE_BQ,
            63 => castling &= !CASTLE_BK,
            _ => {}
        }
    }
    if let Some(cap) = captured_piece {
        if cap.to_ascii_lowercase() == 'r' {
            match mv.to {
                0 => castling &= !CASTLE_WQ,
                7 => castling &= !CASTLE_WK,
                56 => castling &= !CASTLE_BQ,
                63 => castling &= !CASTLE_BK,
                _ => {}
            }
        }
    }

    let mut new_ep = None;
    if piece.to_ascii_lowercase() == 'p' {
        let from_rank = mv.from / 8;
        let to_rank = mv.to / 8;
        if color == Color::White && from_rank == 1 && to_rank == 3 {
            new_ep = Some(mv.from + 8);
        } else if color == Color::Black && from_rank == 6 && to_rank == 4 {
            new_ep = Some(mv.from - 8);
        }
    }

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

    let mut fullmove = pos.fullmove;
    if pos.side_to_move == Color::Black {
        fullmove += 1;
    }

    let mut new_hash = hash;
    new_hash ^= zob.side;
    new_hash ^= zob.castle[(pos.castling & 0x0F) as usize] ^ zob.castle[(castling & 0x0F) as usize];
    if let Some(ep) = pos.ep {
        let file = (ep % 8) as usize;
        new_hash ^= zob.ep_file[file + 1];
    }
    if let Some(ep) = new_ep {
        let file = (ep % 8) as usize;
        new_hash ^= zob.ep_file[file + 1];
    }

    if let Some(idx) = piece_index(piece) {
        new_hash ^= zob.piece_sq[idx][mv.from as usize];
    }
    if let (Some(cap), Some(sq)) = (captured_piece, cap_sq) {
        if let Some(idx) = piece_index(cap) {
            new_hash ^= zob.piece_sq[idx][sq as usize];
        }
    }
    if let Some(idx) = piece_index(placed) {
        new_hash ^= zob.piece_sq[idx][mv.to as usize];
    }
    if mv.kind == MoveKind::Castle {
        let (rook_from, rook_to) = if color == Color::White {
            if mv.to == 6 { (7usize, 5usize) } else { (0usize, 3usize) }
        } else {
            if mv.to == 62 { (63usize, 61usize) } else { (56usize, 59usize) }
        };
        let rook_piece = if color == Color::White { 'R' } else { 'r' };
        if let Some(idx) = piece_index(rook_piece) {
            new_hash ^= zob.piece_sq[idx][rook_from];
            new_hash ^= zob.piece_sq[idx][rook_to];
        }
    }

    Some((Position {
        board,
        side_to_move: pos.side_to_move.opposite(),
        castling,
        ep: new_ep,
        halfmove,
        fullmove,
        bb,
    }, new_hash))
}

struct Undo {
    captured: Option<char>,
    captured_sq: Option<u8>,
    prev_castling: u8,
    prev_ep: Option<u8>,
    prev_halfmove: u32,
    prev_fullmove: u32,
    moved_piece: char,
}

fn make_move_in_place(pos: &mut Position, mv: Move, promotion: Option<char>) -> Option<Undo> {
    let piece = pos.board[mv.from as usize]?;
    let color = piece_color(piece);
    if color != pos.side_to_move {
        return None;
    }

    let mut cap_sq = None;
    let captured = match mv.kind {
        MoveKind::EnPassant => {
            let sq = if color == Color::White { mv.to - 8 } else { mv.to + 8 };
            cap_sq = Some(sq);
            pos.board[sq as usize]
        }
        _ => {
            let cap = pos.board[mv.to as usize];
            if cap.is_some() {
                cap_sq = Some(mv.to);
            }
            cap
        }
    };

    let undo = Undo {
        captured,
        captured_sq: cap_sq,
        prev_castling: pos.castling,
        prev_ep: pos.ep,
        prev_halfmove: pos.halfmove,
        prev_fullmove: pos.fullmove,
        moved_piece: piece,
    };

    remove_piece(&mut pos.bb, piece, mv.from);
    if let (Some(cap), Some(sq)) = (captured, cap_sq) {
        remove_piece(&mut pos.bb, cap, sq);
    }

    apply_move_to_board(&mut pos.board, mv, color, promotion);

    let mut placed = piece;
    if let MoveKind::Promotion = mv.kind {
        let promo = promotion.unwrap_or('q').to_ascii_lowercase();
        let mut placed_piece = match promo {
            'q' | 'r' | 'b' | 'n' => promo,
            _ => 'q',
        };
        if piece.is_ascii_uppercase() {
            placed_piece = placed_piece.to_ascii_uppercase();
        }
        placed = placed_piece;
    }
    add_piece(&mut pos.bb, placed, mv.to);

    if mv.kind == MoveKind::Castle {
        let (rook_from, rook_to) = if color == Color::White {
            if mv.to == 6 { (7u8, 5u8) } else { (0u8, 3u8) }
        } else {
            if mv.to == 62 { (63u8, 61u8) } else { (56u8, 59u8) }
        };
        let rook_piece = if color == Color::White { 'R' } else { 'r' };
        remove_piece(&mut pos.bb, rook_piece, rook_from);
        add_piece(&mut pos.bb, rook_piece, rook_to);
    }

    let mut castling = pos.castling;
    if piece.to_ascii_lowercase() == 'k' {
        if color == Color::White {
            castling &= !(CASTLE_WK | CASTLE_WQ);
        } else {
            castling &= !(CASTLE_BK | CASTLE_BQ);
        }
    }
    if piece.to_ascii_lowercase() == 'r' {
        match mv.from {
            0 => castling &= !CASTLE_WQ,
            7 => castling &= !CASTLE_WK,
            56 => castling &= !CASTLE_BQ,
            63 => castling &= !CASTLE_BK,
            _ => {}
        }
    }
    if let Some(cap) = captured {
        if cap.to_ascii_lowercase() == 'r' {
            match mv.to {
                0 => castling &= !CASTLE_WQ,
                7 => castling &= !CASTLE_WK,
                56 => castling &= !CASTLE_BQ,
                63 => castling &= !CASTLE_BK,
                _ => {}
            }
        }
    }

    let mut new_ep = None;
    if piece.to_ascii_lowercase() == 'p' {
        let from_rank = mv.from / 8;
        let to_rank = mv.to / 8;
        if color == Color::White && from_rank == 1 && to_rank == 3 {
            new_ep = Some(mv.from + 8);
        } else if color == Color::Black && from_rank == 6 && to_rank == 4 {
            new_ep = Some(mv.from - 8);
        }
    }

    let mut halfmove = pos.halfmove;
    let is_capture = match mv.kind {
        MoveKind::EnPassant => true,
        _ => captured.is_some(),
    };
    if piece.to_ascii_lowercase() == 'p' || is_capture {
        halfmove = 0;
    } else {
        halfmove += 1;
    }

    let mut fullmove = pos.fullmove;
    if pos.side_to_move == Color::Black {
        fullmove += 1;
    }

    pos.castling = castling;
    pos.ep = new_ep;
    pos.halfmove = halfmove;
    pos.fullmove = fullmove;
    pos.side_to_move = pos.side_to_move.opposite();

    Some(undo)
}

fn unmake_move_in_place(pos: &mut Position, mv: Move, _promotion: Option<char>, undo: Undo) {
    pos.side_to_move = pos.side_to_move.opposite();
    pos.castling = undo.prev_castling;
    pos.ep = undo.prev_ep;
    pos.halfmove = undo.prev_halfmove;
    pos.fullmove = undo.prev_fullmove;

    let color = pos.side_to_move;
    let to = mv.to as usize;
    let from = mv.from as usize;

    if let Some(p) = pos.board[to] {
        remove_piece(&mut pos.bb, p, mv.to);
    }
    pos.board[to] = None;

    if mv.kind == MoveKind::Castle {
        let (rook_from, rook_to) = if color == Color::White {
            if mv.to == 6 { (7u8, 5u8) } else { (0u8, 3u8) }
        } else {
            if mv.to == 62 { (63u8, 61u8) } else { (56u8, 59u8) }
        };
        let rook_piece = if color == Color::White { 'R' } else { 'r' };
        if let Some(p) = pos.board[rook_to as usize] {
            remove_piece(&mut pos.bb, p, rook_to);
        }
        pos.board[rook_to as usize] = None;
        pos.board[rook_from as usize] = Some(rook_piece);
        add_piece(&mut pos.bb, rook_piece, rook_from);
    }

    if let (Some(cap), Some(sq)) = (undo.captured, undo.captured_sq) {
        pos.board[sq as usize] = Some(cap);
        add_piece(&mut pos.bb, cap, sq);
    }

    pos.board[from] = Some(undo.moved_piece);
    add_piece(&mut pos.bb, undo.moved_piece, mv.from);
}

fn update_hash_after_move(
    hash: u64,
    zob: &Zobrist,
    undo: &Undo,
    pos_after: &Position,
    mv: Move,
) -> u64 {
    let mut new_hash = hash;
    new_hash ^= zob.side;
    new_hash ^=
        zob.castle[(undo.prev_castling & 0x0F) as usize] ^
        zob.castle[(pos_after.castling & 0x0F) as usize];
    if let Some(ep) = undo.prev_ep {
        let file = (ep % 8) as usize;
        new_hash ^= zob.ep_file[file + 1];
    }
    if let Some(ep) = pos_after.ep {
        let file = (ep % 8) as usize;
        new_hash ^= zob.ep_file[file + 1];
    }
    if let Some(idx) = piece_index(undo.moved_piece) {
        new_hash ^= zob.piece_sq[idx][mv.from as usize];
    }
    if let (Some(cap), Some(sq)) = (undo.captured, undo.captured_sq) {
        if let Some(idx) = piece_index(cap) {
            new_hash ^= zob.piece_sq[idx][sq as usize];
        }
    }
    if let Some(placed) = pos_after.board[mv.to as usize] {
        if let Some(idx) = piece_index(placed) {
            new_hash ^= zob.piece_sq[idx][mv.to as usize];
        }
    }
    if mv.kind == MoveKind::Castle {
        let color = piece_color(undo.moved_piece);
        let (rook_from, rook_to) = if color == Color::White {
            if mv.to == 6 { (7usize, 5usize) } else { (0usize, 3usize) }
        } else {
            if mv.to == 62 { (63usize, 61usize) } else { (56usize, 59usize) }
        };
        let rook_piece = if color == Color::White { 'R' } else { 'r' };
        if let Some(idx) = piece_index(rook_piece) {
            new_hash ^= zob.piece_sq[idx][rook_from];
            new_hash ^= zob.piece_sq[idx][rook_to];
        }
    }
    new_hash
}

fn move_to_uci(mv: Move, promotion: Option<char>) -> String {
    let mut out = String::new();
    out.push_str(&field_to_lan(mv.from));
    out.push_str(&field_to_lan(mv.to));
    if let Some(p) = promotion {
        out.push(p.to_ascii_lowercase());
    }
    out
}

fn capture_info(pos: &Position, mv: Move) -> Option<(u8, char)> {
    match mv.kind {
        MoveKind::EnPassant => {
            let cap_sq = if pos.side_to_move == Color::White {
                mv.to - 8
            } else {
                mv.to + 8
            };
            pos.board[cap_sq as usize].map(|p| (cap_sq, p))
        }
        _ => pos.board[mv.to as usize].map(|p| (mv.to, p)),
    }
}

fn move_is_capture(pos: &Position, mv: Move) -> bool {
    capture_info(pos, mv).is_some()
}

fn move_key(mv: Move, promo: Option<char>) -> (u8, u8, u8) {
    (mv.from, mv.to, encode_promo(promo))
}

fn is_quiet_move(pos: &Position, mv: Move, promo: Option<char>) -> bool {
    if let MoveKind::Promotion = mv.kind {
        return false;
    }
    if promo.is_some() {
        return false;
    }
    !move_is_capture(pos, mv)
}

fn update_killers(ctx: &mut SearchContext, ply: i32, key: (u8, u8, u8)) {
    if ply < 0 {
        return;
    }
    let idx = ply as usize;
    if idx >= ctx.killers.len() {
        return;
    }
    if ctx.killers[idx][0] == Some(key) {
        return;
    }
    ctx.killers[idx][1] = ctx.killers[idx][0];
    ctx.killers[idx][0] = Some(key);
}

fn update_history_heur(ctx: &mut SearchContext, color: Color, from: u8, to: u8, depth: u32) {
    let c = if color == Color::White { 0 } else { 1 };
    let entry = &mut ctx.history_heur[c][from as usize][to as usize];
    let inc = (depth as i32).saturating_mul(depth as i32);
    *entry = entry.saturating_add(inc);
}

struct MoveOrderScratch {
    captures: Vec<(i32, Move, Option<char>)>,
    quiet: Vec<(i32, Move, Option<char>)>,
    rest: Vec<(Move, Option<char>)>,
}

impl MoveOrderScratch {
    fn new() -> Self {
        MoveOrderScratch {
            captures: Vec::new(),
            quiet: Vec::new(),
            rest: Vec::new(),
        }
    }
}

fn capture_score(pos: &Position, mv: Move, promo: Option<char>) -> i32 {
    let mut score = 0;
    if let Some(p) = promo {
        score += 5000 + piece_value(p.to_ascii_lowercase());
    } else if let MoveKind::Promotion = mv.kind {
        score += 5000;
    }
    if let Some((_, cap)) = capture_info(pos, mv) {
        let mover = pos.board[mv.from as usize].unwrap_or('P');
        score += 3000 + piece_value(cap) - piece_value(mover);
    }
    score
}

fn order_moves_in_place(
    pos: &Position,
    moves: &mut Vec<(Move, Option<char>)>,
    pv_move: Option<(u8, u8, Option<char>)>,
    tt_entry: Option<TTEntry>,
    killers: Option<&[Option<(u8, u8, u8)>; 2]>,
    history_heur: Option<&[[[i32; 64]; 64]; 2]>,
    scratch: &mut MoveOrderScratch,
) {
    let pv_best = pv_move;
    let tt_best = tt_entry.and_then(entry_best_move);
    let hash_best = if tt_best.is_some() { tt_best } else { pv_best };
    let mut hash_move: Option<(Move, Option<char>)> = None;
    let mut killer_moves: [Option<(Move, Option<char>)>; 2] = [None, None];
    scratch.captures.clear();
    scratch.quiet.clear();
    scratch.rest.clear();

    for (mv, promo) in moves.drain(..) {
        if let Some((bf, bt, bp)) = hash_best {
            if mv.from == bf && mv.to == bt && promo == bp {
                hash_move = Some((mv, promo));
                continue;
            }
        }

        let is_capture = move_is_capture(pos, mv) || matches!(mv.kind, MoveKind::Promotion) || promo.is_some();
        if is_capture {
            scratch.captures.push((capture_score(pos, mv, promo), mv, promo));
            continue;
        }

        let key = move_key(mv, promo);
        if let Some(k) = killers {
            if k[0] == Some(key) {
                killer_moves[0] = Some((mv, promo));
                continue;
            }
            if k[1] == Some(key) {
                killer_moves[1] = Some((mv, promo));
                continue;
            }
        }

        if let Some(hist) = history_heur {
            if is_quiet_move(pos, mv, promo) {
                let c = if pos.side_to_move == Color::White { 0 } else { 1 };
                scratch.quiet.push((hist[c][mv.from as usize][mv.to as usize], mv, promo));
                continue;
            }
        }

        scratch.rest.push((mv, promo));
    }

    scratch.captures.sort_by(|a, b| b.0.cmp(&a.0));

    const QUIET_SORT_LIMIT: usize = 12;
    if scratch.quiet.len() > 1 {
        if scratch.quiet.len() > QUIET_SORT_LIMIT {
            scratch.quiet.select_nth_unstable_by(QUIET_SORT_LIMIT, |a, b| b.0.cmp(&a.0));
            scratch.quiet[..QUIET_SORT_LIMIT].sort_by(|a, b| b.0.cmp(&a.0));
        } else {
            scratch.quiet.sort_by(|a, b| b.0.cmp(&a.0));
        }
    }

    moves.clear();
    if let Some(mv) = hash_move {
        moves.push(mv);
    }
    for (_, mv, promo) in scratch.captures.drain(..) {
        moves.push((mv, promo));
    }
    if let Some(mv) = killer_moves[0] {
        moves.push(mv);
    }
    if let Some(mv) = killer_moves[1] {
        moves.push(mv);
    }
    for (_, mv, promo) in scratch.quiet.drain(..) {
        moves.push((mv, promo));
    }
    moves.append(&mut scratch.rest);
}

fn generate_tactical_moves_into(pos: &mut Position, out: &mut Vec<(Move, Option<char>)>) {
    out.clear();
    let mut piece_moves: Vec<Move> = Vec::with_capacity(32);
    for from in 0u8..64u8 {
        generate_moves_for_piece_into(pos, from, &mut piece_moves);
        for mv in piece_moves.iter().copied() {
            if !is_move_legal(pos, mv, pos.side_to_move) {
                continue;
            }
            if move_is_capture(pos, mv) {
                if let MoveKind::Promotion = mv.kind {
                    for promo in ['q', 'r', 'b', 'n'] {
                        out.push((mv, Some(promo)));
                    }
                } else {
                    out.push((mv, None));
                }
            } else if let MoveKind::Promotion = mv.kind {
                for promo in ['q', 'r', 'b', 'n'] {
                    out.push((mv, Some(promo)));
                }
            }
        }
    }
}

fn generate_tactical_moves(pos: &mut Position) -> Vec<(Move, Option<char>)> {
    let mut out = Vec::new();
    generate_tactical_moves_into(pos, &mut out);
    out
}

// ---------------------------
// Zobrist + TT
// ---------------------------
fn splitmix64(seed: &mut u64) -> u64 {
    *seed = seed.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *seed;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

struct Zobrist {
    piece_sq: [[u64; 64]; 12],
    side: u64,
    castle: [u64; 16],
    ep_file: [u64; 9],
}

impl Zobrist {
    fn new() -> Zobrist {
        let mut seed = 0xC0FFEE_u64 ^ 0x9E3779B97F4A7C15;
        let mut piece_sq = [[0u64; 64]; 12];
        for p in 0..12 {
            for sq in 0..64 {
                piece_sq[p][sq] = splitmix64(&mut seed);
            }
        }
        let side = splitmix64(&mut seed);
        let mut castle = [0u64; 16];
        for i in 0..16 {
            castle[i] = splitmix64(&mut seed);
        }
        let mut ep_file = [0u64; 9];
        for i in 0..9 {
            ep_file[i] = splitmix64(&mut seed);
        }

        Zobrist { piece_sq, side, castle, ep_file }
    }
}

fn piece_index(ch: char) -> Option<usize> {
    match ch {
        'P' => Some(0),
        'N' => Some(1),
        'B' => Some(2),
        'R' => Some(3),
        'Q' => Some(4),
        'K' => Some(5),
        'p' => Some(6),
        'n' => Some(7),
        'b' => Some(8),
        'r' => Some(9),
        'q' => Some(10),
        'k' => Some(11),
        _ => None,
    }
}

fn compute_hash(pos: &Position, zob: &Zobrist) -> u64 {
    let mut h = 0u64;
    for sq in 0..64 {
        if let Some(p) = pos.board[sq] {
            if let Some(idx) = piece_index(p) {
                h ^= zob.piece_sq[idx][sq];
            }
        }
    }
    if pos.side_to_move == Color::Black {
        h ^= zob.side;
    }
    h ^= zob.castle[(pos.castling & 0x0F) as usize];
    if let Some(ep) = pos.ep {
        let file = (ep % 8) as usize;
        h ^= zob.ep_file[file + 1];
    }
    h
}

const TT_BOUND_EXACT: u8 = 0;
const TT_BOUND_LOWER: u8 = 1;
const TT_BOUND_UPPER: u8 = 2;

#[derive(Copy, Clone)]
struct TTEntry {
    key: u64,
    depth: u16,
    value: i32,
    bound: u8,
    best_from: u8,
    best_to: u8,
    best_promo: u8,
    gen: u8,
}

impl Default for TTEntry {
    fn default() -> Self {
        TTEntry {
            key: 0,
            depth: 0,
            value: 0,
            bound: TT_BOUND_EXACT,
            best_from: 0,
            best_to: 0,
            best_promo: 0,
            gen: 0,
        }
    }
}

const TT_BUCKET_SIZE: usize = 4;

struct TT {
    entries: Vec<TTEntry>,
    mask: usize,
}

impl TT {
    fn new(tt_mb: u32) -> Option<TT> {
        if tt_mb == 0 {
            return None;
        }
        let capped_mb = if tt_mb > 256 { 256 } else { tt_mb };
        let bytes = (capped_mb as usize).saturating_mul(1024 * 1024);
        let entry_size = size_of::<TTEntry>();
        if bytes < entry_size {
            return None;
        }
        let n = bytes / entry_size;
        if n == 0 {
            return None;
        }
        let mut size = 1usize;
        while size.saturating_mul(2) <= n {
            size *= 2;
        }
        while size > TT_BUCKET_SIZE && size % TT_BUCKET_SIZE != 0 {
            size >>= 1;
        }
        if size < TT_BUCKET_SIZE {
            return None;
        }
        let entries = vec![TTEntry::default(); size];
        let buckets = size / TT_BUCKET_SIZE;
        Some(TT { entries, mask: buckets - 1 })
    }

    fn probe(&self, key: u64) -> Option<TTEntry> {
        if self.entries.is_empty() {
            return None;
        }
        let bucket = (key as usize) & self.mask;
        let start = bucket * TT_BUCKET_SIZE;
        let end = start + TT_BUCKET_SIZE;
        for entry in self.entries[start..end].iter().copied() {
            if entry.depth == 0 {
                continue;
            }
            if entry.key == key {
                return Some(entry);
            }
        }
        None
    }

    fn store(&mut self, key: u64, depth: u32, value: i32, bound: u8, best: Option<(Move, Option<char>)>, gen: u8) {
        if self.entries.is_empty() {
            return;
        }
        let bucket = (key as usize) & self.mask;
        let start = bucket * TT_BUCKET_SIZE;
        let end = start + TT_BUCKET_SIZE;
        let depth_u16 = depth as u16;

        let mut replace_idx: Option<usize> = None;
        let mut oldest_age: u8 = 0;
        let mut shallowest_depth: u16 = u16::MAX;

        for i in start..end {
            let entry = self.entries[i];
            if entry.depth == 0 {
                replace_idx = Some(i);
                break;
            }
            if entry.key == key {
                if entry.depth > depth_u16 && entry.gen == gen {
                    return;
                }
                replace_idx = Some(i);
                break;
            }

            let age = gen.wrapping_sub(entry.gen);
            if replace_idx.is_none()
                || age > oldest_age
                || (age == oldest_age && entry.depth < shallowest_depth)
            {
                replace_idx = Some(i);
                oldest_age = age;
                shallowest_depth = entry.depth;
            }
        }
        let idx = match replace_idx {
            Some(i) => i,
            None => start,
        };
        let (best_from, best_to, best_promo) = if let Some((mv, promo)) = best {
            (mv.from, mv.to, encode_promo(promo))
        } else {
            (0, 0, 0)
        };
        self.entries[idx] = TTEntry {
            key,
            depth: depth_u16,
            value,
            bound,
            best_from,
            best_to,
            best_promo,
            gen,
        };
    }
}

fn encode_promo(promo: Option<char>) -> u8 {
    match promo.map(|c| c.to_ascii_lowercase()) {
        Some('q') => 1,
        Some('r') => 2,
        Some('b') => 3,
        Some('n') => 4,
        _ => 0,
    }
}

fn decode_promo(code: u8) -> Option<char> {
    match code {
        1 => Some('q'),
        2 => Some('r'),
        3 => Some('b'),
        4 => Some('n'),
        _ => None,
    }
}

fn entry_best_move(entry: TTEntry) -> Option<(u8, u8, Option<char>)> {
    if entry.best_from == 0 && entry.best_to == 0 && entry.best_promo == 0 {
        None
    } else {
        Some((entry.best_from, entry.best_to, decode_promo(entry.best_promo)))
    }
}

struct TTState {
    mb: u32,
    gen: u8,
    table: Option<TT>,
    killers: Vec<[Option<(u8, u8, u8)>; 2]>,
    history_heur: [[[i32; 64]; 64]; 2],
}

impl TTState {
    fn new() -> Self {
        TTState {
            mb: 0,
            gen: 0,
            table: None,
            killers: Vec::new(),
            history_heur: [[[0i32; 64]; 64]; 2],
        }
    }
}

thread_local! {
    static TT_STATE: RefCell<TTState> = RefCell::new(TTState::new());
}

fn with_tt_state<F, R>(tt_mb: u32, max_ply: usize, f: F) -> R
where
    F: FnOnce(&mut TTState) -> R,
{
    TT_STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if state.mb != tt_mb {
            state.table = TT::new(tt_mb);
            state.mb = tt_mb;
        }
        if state.killers.len() < max_ply {
            state.killers.resize(max_ply, [None; 2]);
        }
        f(&mut state)
    })
}

struct SearchContext {
    nodes: u64,
    start_ms: f64,
    time_limit_ms: f64,
    time_check_interval_ms: f64,
    last_time_check_ms: f64,
    stop: bool,
    tt_gen: u8,
    history: Vec<u64>,
    rep_counts: HashMap<u64, u8>,
    killers: Vec<[Option<(u8, u8, u8)>; 2]>,
    history_heur: [[[i32; 64]; 64]; 2],
    move_buf: Vec<Vec<(Move, Option<char>)>>,
    order_scratch: MoveOrderScratch,
}

#[inline]
fn history_count(ctx: &SearchContext, hash: u64) -> u8 {
    ctx.rep_counts.get(&hash).copied().unwrap_or(0)
}

#[inline]
fn history_push(ctx: &mut SearchContext, hash: u64) {
    ctx.history.push(hash);
    let entry = ctx.rep_counts.entry(hash).or_insert(0);
    *entry = entry.saturating_add(1);
}

#[inline]
fn history_pop(ctx: &mut SearchContext) {
    if let Some(h) = ctx.history.pop() {
        if let Some(c) = ctx.rep_counts.get_mut(&h) {
            if *c > 1 {
                *c -= 1;
            } else {
                ctx.rep_counts.remove(&h);
            }
        }
    }
}

#[inline]
fn should_stop(ctx: &mut SearchContext) -> bool {
    if ctx.stop {
        return true;
    }
    if ctx.time_limit_ms <= 0.0 {
        return false;
    }
    if (ctx.nodes & (TIME_CHECK_NODE_INTERVAL - 1)) != 0 {
        return false;
    }
    let now = now_ms();
    if now - ctx.last_time_check_ms < ctx.time_check_interval_ms {
        return false;
    }
    ctx.last_time_check_ms = now;
    if now - ctx.start_ms >= ctx.time_limit_ms {
        ctx.stop = true;
        return true;
    }
    false
}

fn take_move_buf(ctx: &mut SearchContext, ply: i32) -> Vec<(Move, Option<char>)> {
    let idx = if ply < 0 { 0 } else { ply as usize };
    if idx >= ctx.move_buf.len() {
        ctx.move_buf.resize_with(idx + 1, Vec::new);
    }
    std::mem::take(&mut ctx.move_buf[idx])
}

fn restore_move_buf(ctx: &mut SearchContext, ply: i32, buf: Vec<(Move, Option<char>)>) {
    let idx = if ply < 0 { 0 } else { ply as usize };
    if idx >= ctx.move_buf.len() {
        ctx.move_buf.resize_with(idx + 1, Vec::new);
    }
    ctx.move_buf[idx] = buf;
}

fn quiescence(
    pos: &mut Position,
    mut alpha: i32,
    beta: i32,
    ctx: &mut SearchContext,
    tt: &mut Option<TT>,
    zob: &Zobrist,
    hash: u64,
    ply: i32,
) -> i32 {
    if ctx.stop {
        return 0;
    }
    if pos.halfmove >= 100 {
        return 0;
    }
    if history_count(ctx, hash) >= 3 {
        return 0;
    }

    ctx.nodes += 1;
    if should_stop(ctx) {
        return 0;
    }

    if let Some(table) = tt.as_ref() {
        if let Some(entry) = table.probe(hash) {
            let val = tt_probe_score(entry.value, ply);
            match entry.bound {
                TT_BOUND_EXACT => return val,
                TT_BOUND_LOWER => {
                    if val >= beta {
                        return val;
                    }
                }
                TT_BOUND_UPPER => {
                    if val <= alpha {
                        return val;
                    }
                }
                _ => {}
            }
        }
    }

    let stand_pat = clamp_eval(evaluate_fast(pos));
    if stand_pat >= beta {
        return beta;
    }
    if stand_pat > alpha {
        alpha = stand_pat;
    }

    let in_check = is_in_check(pos, pos.side_to_move);
    let mut moves = take_move_buf(ctx, ply);
    if in_check {
        generate_legal_moves_into(pos, &mut moves);
    } else {
        generate_tactical_moves_into(pos, &mut moves);
        // Optional: auch ruhige Schachs hinzufügen (wichtig für Mattnetze).
        let mut extra = take_move_buf(ctx, ply + 1);
        generate_legal_moves_into(pos, &mut extra);
        for (mv, promo) in extra.iter().copied() {
            if !is_quiet_move(pos, mv, promo) {
                continue;
            }
            let Some(undo) = make_move_in_place(pos, mv, promo) else { continue; };
            let gives_check = is_in_check(pos, pos.side_to_move);
            unmake_move_in_place(pos, mv, promo, undo);
            if gives_check {
                moves.push((mv, promo));
            }
        }
        restore_move_buf(ctx, ply + 1, extra);
    }

    if moves.is_empty() {
        if in_check {
            restore_move_buf(ctx, ply, moves);
            return -mate_score(ply);
        }
        restore_move_buf(ctx, ply, moves);
        return stand_pat;
    }

    order_moves_in_place(pos, &mut moves, None, None, None, Some(&ctx.history_heur), &mut ctx.order_scratch);
    for (mv, promo) in moves.iter().copied() {
        if ctx.stop {
            break;
        }
        let Some(undo) = make_move_in_place(pos, mv, promo) else { continue; };
        let next_hash = update_hash_after_move(hash, zob, &undo, pos, mv);
        history_push(ctx, next_hash);
        let score = -quiescence(pos, -beta, -alpha, ctx, tt, zob, next_hash, ply + 1);
        history_pop(ctx);
        unmake_move_in_place(pos, mv, promo, undo);
        if ctx.stop {
            break;
        }
        if score >= beta {
            restore_move_buf(ctx, ply, moves);
            return beta;
        }
        if score > alpha {
            alpha = score;
        }
    }

    restore_move_buf(ctx, ply, moves);
    alpha
}

fn negamax(
    pos: &mut Position,
    depth: u32,
    mut alpha: i32,
    beta: i32,
    ctx: &mut SearchContext,
    tt: &mut Option<TT>,
    zob: &Zobrist,
    hash: u64,
    ply: i32,
) -> i32 {
    if ctx.stop {
        return 0;
    }
    if pos.halfmove >= 100 {
        return 0;
    }
    if history_count(ctx, hash) >= 3 {
        return 0;
    }

    ctx.nodes += 1;
    if should_stop(ctx) {
        return 0;
    }

    let tt_entry = {
        if let Some(table) = tt.as_ref() {
            table.probe(hash)
        } else {
            None
        }
    };
    if let Some(entry) = tt_entry {
        if entry.depth as u32 >= depth {
            let val = tt_probe_score(entry.value, ply);
            match entry.bound {
                TT_BOUND_EXACT => return val,
                TT_BOUND_LOWER => {
                    if val >= beta {
                        return val;
                    }
                }
                TT_BOUND_UPPER => {
                    if val <= alpha {
                        return val;
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(entry) = tt_entry {
        if entry.depth as u32 >= depth {
            let val = tt_probe_score(entry.value, ply);
            match entry.bound {
                TT_BOUND_EXACT => return val,
                TT_BOUND_LOWER => {
                    if val >= beta {
                        return val;
                    }
                }
                TT_BOUND_UPPER => {
                    if val <= alpha {
                        return val;
                    }
                }
                _ => {}
            }
        }
    }

    if depth == 0 {
        return quiescence(pos, alpha, beta, ctx, tt, zob, hash, ply);
    }

    let in_check = is_in_check(pos, pos.side_to_move);

    let mut moves = take_move_buf(ctx, ply);
    generate_legal_moves_into(pos, &mut moves);
    if moves.is_empty() {
        restore_move_buf(ctx, ply, moves);
        return if is_in_check(pos, pos.side_to_move) {
            -mate_score(ply)
        } else {
            0
        };
    }
    let killers = if ply < 0 { None } else { ctx.killers.get(ply as usize) };
    let history_heur = Some(&ctx.history_heur);
    order_moves_in_place(pos, &mut moves, None, tt_entry, killers, history_heur, &mut ctx.order_scratch);

    let orig_alpha = alpha;
    let mut best = -INF_SCORE;
    let mut best_move: Option<(Move, Option<char>)> = None;
    let mut first = true;
    let mut move_index: usize = 0;
    for (mv, promo) in moves.iter().copied() {
        move_index = move_index.saturating_add(1);
        if ctx.stop {
            break;
        }
        let is_quiet = is_quiet_move(pos, mv, promo);
        let Some(undo) = make_move_in_place(pos, mv, promo) else { continue; };
        let gives_check = is_in_check(pos, pos.side_to_move);
        let next_hash = update_hash_after_move(hash, zob, &undo, pos, mv);
        history_push(ctx, next_hash);
        let extend = gives_check && depth <= 3;
        let base_depth = depth - 1 + if extend { 1 } else { 0 };
        let use_lmr = !first
            && ply > 0
            && base_depth >= 3
            && move_index > 3
            && is_quiet
            && !in_check
            && !gives_check;

        let score = if first {
            -negamax(pos, base_depth, -beta, -alpha, ctx, tt, zob, next_hash, ply + 1)
        } else if use_lmr {
            let narrow = alpha.saturating_add(1);
            let reduced_depth = base_depth.saturating_sub(1);
            let mut sc = -negamax(pos, reduced_depth, -narrow, -alpha, ctx, tt, zob, next_hash, ply + 1);
            if sc > alpha {
                sc = -negamax(pos, base_depth, -narrow, -alpha, ctx, tt, zob, next_hash, ply + 1);
                if sc > alpha && sc < beta {
                    sc = -negamax(pos, base_depth, -beta, -alpha, ctx, tt, zob, next_hash, ply + 1);
                }
            }
            sc
        } else {
            let narrow = alpha.saturating_add(1);
            let mut sc = -negamax(pos, base_depth, -narrow, -alpha, ctx, tt, zob, next_hash, ply + 1);
            if sc > alpha && sc < beta {
                sc = -negamax(pos, base_depth, -beta, -alpha, ctx, tt, zob, next_hash, ply + 1);
            }
            sc
        };
        history_pop(ctx);
        unmake_move_in_place(pos, mv, promo, undo);
        first = false;
        if ctx.stop {
            break;
        }
        if score > best {
            best = score;
            best_move = Some((mv, promo));
        }
        if score > alpha {
            alpha = score;
        }
        if alpha >= beta {
            if is_quiet {
                let key = move_key(mv, promo);
                update_killers(ctx, ply, key);
                update_history_heur(ctx, pos.side_to_move, mv.from, mv.to, depth);
            }
            break;
        }
    }

    if best == -INF_SCORE {
        best = clamp_eval(evaluate(pos));
    }

    if !ctx.stop {
        let bound = if best <= orig_alpha {
            TT_BOUND_UPPER
        } else if best >= beta {
            TT_BOUND_LOWER
        } else {
            TT_BOUND_EXACT
        };
        if let Some(table) = tt.as_mut() {
            table.store(hash, depth, tt_store_score(best, ply), bound, best_move, ctx.tt_gen);
        }
    }

    restore_move_buf(ctx, ply, moves);
    best
}

fn search_depth(
    pos: &mut Position,
    depth: u32,
    ctx: &mut SearchContext,
    tt: &mut Option<TT>,
    zob: &Zobrist,
    hash: u64,
    alpha: i32,
    beta: i32,
    pv_move: Option<(u8, u8, Option<char>)>,
) -> (i32, Option<(Move, Option<char>)>, bool) {
    if pos.halfmove >= 100 {
        return (0, None, false);
    }
    if depth == 0 {
        let score = quiescence(pos, -INF_SCORE, INF_SCORE, ctx, tt, zob, hash, 0);
        return (score, None, false);
    }

    let tt_entry = {
        if let Some(table) = tt.as_ref() {
            table.probe(hash)
        } else {
            None
        }
    };

    let mut moves = take_move_buf(ctx, 0);
    generate_legal_moves_into(pos, &mut moves);
    if moves.is_empty() {
        let score = if is_in_check(pos, pos.side_to_move) { -mate_score(0) } else { 0 };
        restore_move_buf(ctx, 0, moves);
        return (score, None, false);
    }
    let killers = ctx.killers.get(0);
    let history_heur = Some(&ctx.history_heur);
    order_moves_in_place(pos, &mut moves, pv_move, tt_entry, killers, history_heur, &mut ctx.order_scratch);

    let mut alpha = alpha;
    let beta = beta;
    let orig_alpha = alpha;
    let mut best = None;
    let mut best_score = -INF_SCORE;
    let mut best_is_rep = false;
    let mut best_non_rep_non_losing: Option<(Move, Option<char>)> = None;
    let mut best_non_rep_non_losing_score = -INF_SCORE;
    let mut rep_avoid_used = false;

    let mut first = true;
    for (mv, promo) in moves.iter().copied() {
        if ctx.stop {
            break;
        }
        if should_stop(ctx) {
            break;
        }
        let Some(undo) = make_move_in_place(pos, mv, promo) else { continue; };
        let next_hash = update_hash_after_move(hash, zob, &undo, pos, mv);
        let rep_count = history_count(ctx, next_hash) as usize;
        let is_rep_draw = rep_count >= 2;
        history_push(ctx, next_hash);
        let score = if first {
            -negamax(pos, depth - 1, -beta, -alpha, ctx, tt, zob, next_hash, 1)
        } else {
            let narrow = alpha.saturating_add(1);
            let mut sc = -negamax(pos, depth - 1, -narrow, -alpha, ctx, tt, zob, next_hash, 1);
            if sc > alpha && sc < beta {
                sc = -negamax(pos, depth - 1, -beta, -alpha, ctx, tt, zob, next_hash, 1);
            }
            sc
        };
        history_pop(ctx);
        unmake_move_in_place(pos, mv, promo, undo);
        first = false;
        if ctx.stop {
            break;
        }
        if score > best_score {
            best_score = score;
            best = Some((mv, promo));
            best_is_rep = is_rep_draw;
        }
        if score > alpha {
            alpha = score;
        }
        if !is_rep_draw && score >= 0 && score > best_non_rep_non_losing_score {
            best_non_rep_non_losing_score = score;
            best_non_rep_non_losing = Some((mv, promo));
        }
        if alpha >= beta {
            break;
        }
    }

    if !ctx.stop {
        let bound = if alpha <= orig_alpha {
            TT_BOUND_UPPER
        } else if alpha >= beta {
            TT_BOUND_LOWER
        } else {
            TT_BOUND_EXACT
        };
        if let Some(table) = tt.as_mut() {
            table.store(hash, depth, tt_store_score(alpha, 0), bound, best, ctx.tt_gen);
        }
    }

    let mut chosen_score = best_score;
    let mut chosen_move = best;
    if !ctx.stop && best_is_rep {
        if let Some(mv) = best_non_rep_non_losing {
            chosen_score = best_non_rep_non_losing_score;
            chosen_move = Some(mv);
            rep_avoid_used = true;
        }
    }

    const ROOT_CONTEMPT: i32 = 10;
    const ROOT_CONTEMPT_THRESHOLD: i32 = 15;
    if !ctx.stop && best_is_rep && chosen_score.abs() < ROOT_CONTEMPT_THRESHOLD {
        chosen_score -= ROOT_CONTEMPT;
    }

    restore_move_buf(ctx, 0, moves);
    (chosen_score, chosen_move, rep_avoid_used)
}

fn build_history(history: &str, zob: &Zobrist, root_hash: u64) -> Vec<u64> {
    let mut out = Vec::new();
    for line in history.lines() {
        let fen = line.trim();
        if fen.is_empty() {
            continue;
        }
        if let Some(pos) = parse_fen(fen) {
            out.push(compute_hash(&pos, zob));
        }
    }
    if out.len() > 128 {
        let start = out.len() - 128;
        out = out.split_off(start);
    }
    out.push(root_hash);
    out
}

fn build_pv_line(
    pos: &Position,
    tt: &Option<TT>,
    zob: &Zobrist,
    hash: u64,
    max_len: u32,
    first_move: Option<(Move, Option<char>)>,
) -> String {
    if max_len == 0 {
        return String::new();
    }

    let mut pos = clone_position(pos);
    let mut cur_hash = hash;
    let mut line: Vec<String> = Vec::new();
    let mut seen: Vec<u64> = Vec::new();
    let mut next_move = first_move;

    for _ in 0..max_len {
        if seen.contains(&cur_hash) {
            break;
        }
        seen.push(cur_hash);

        let (mv, promo) = if let Some(mv) = next_move.take() {
            mv
        } else {
            let table = match tt.as_ref() {
                Some(t) => t,
                None => break,
            };
            let entry = match table.probe(cur_hash) {
                Some(e) => e,
                None => break,
            };
            let (from, to, promo_hint) = match entry_best_move(entry) {
                Some(m) => m,
                None => break,
            };
            let mv = match find_legal_move(&mut pos, from, to) {
                Some(m) => m,
                None => break,
            };
            let promo = if let MoveKind::Promotion = mv.kind {
                Some(promo_hint.unwrap_or('q').to_ascii_lowercase())
            } else {
                None
            };
            (mv, promo)
        };

        line.push(move_to_uci(mv, promo));

        let Some(undo) = make_move_in_place(&mut pos, mv, promo) else { break; };
        let next_hash = update_hash_after_move(cur_hash, zob, &undo, &pos, mv);
        cur_hash = next_hash;
    }

    line.join(" ")
}

fn search_impl(fen: &str, depth: u32, time_ms: u32, tt_mb: u32, history: &str) -> String {
    let mut pos = match parse_fen(fen) {
        Some(p) => p,
        None => return "{\"error\":\"invalid fen\"}".to_string(),
    };

    let debug_root = ROOT_EVAL_DEBUG.with(|v| v.get());
    let zob = Zobrist::new();
    let root_hash = compute_hash(&pos, &zob);

    let time_limit_ms = time_ms as f64;
    let max_depth = if time_ms > 0 {
        if depth > 0 { depth } else { 64 }
    } else {
        if depth > 0 { depth } else { 1 }
    };
    let max_ply = (max_depth as usize).saturating_add(8);

    with_tt_state(tt_mb, max_ply, |state| {
        state.gen = state.gen.wrapping_add(1);
        if state.gen == 0 {
            state.gen = 1;
        }
        let tt_gen = state.gen;

        let mut killers = std::mem::take(&mut state.killers);
        if killers.len() < max_ply {
            killers.resize(max_ply, [None; 2]);
        }
        let history_heur = state.history_heur;

        let start_ms = now_ms();
        let time_check_interval_ms = if time_limit_ms <= 0.0 {
            0.0
        } else if time_limit_ms < 1000.0 {
            time_limit_ms
        } else if time_limit_ms < 2000.0 {
            1000.0
        } else {
            2000.0
        };
        let history = build_history(history, &zob, root_hash);
        let mut rep_counts: HashMap<u64, u8> = HashMap::new();
        for h in history.iter() {
            let entry = rep_counts.entry(*h).or_insert(0);
            *entry = entry.saturating_add(1);
        }
        let move_buf = Vec::with_capacity(max_ply);
        let mut ctx = SearchContext {
            nodes: 0,
            start_ms,
            time_limit_ms,
            time_check_interval_ms,
            last_time_check_ms: start_ms,
            stop: false,
            tt_gen,
            history,
            rep_counts,
            killers,
            history_heur,
            move_buf,
            order_scratch: MoveOrderScratch::new(),
        };

    let mut best_move: Option<(Move, Option<char>)> = None;
    let mut best_score = 0;
    let mut completed_depth = 0;
    let mut rep_avoid_used = false;
    let mut pv_move_hint: Option<(u8, u8, Option<char>)> = None;
    let mut last_score = 0;

    const USE_ASPIRATION: bool = true;
    const ASP_WINDOW: i32 = 50;
    const ASP_MAX_ITERS: u32 = 6;

    for d in 1..=max_depth {
        let mut score = 0;
        let mut mv: Option<(Move, Option<char>)> = None;
        let mut rep_avoid = false;

        if USE_ASPIRATION && d > 1 {
            let mut window = ASP_WINDOW;
            let mut alpha = (last_score - window).max(-INF_SCORE);
            let mut beta = (last_score + window).min(INF_SCORE);
            let mut attempts = 0;

            loop {
                let (s, m, r) = search_depth(&mut pos, d, &mut ctx, &mut state.table, &zob, root_hash, alpha, beta, pv_move_hint);
                if ctx.stop {
                    break;
                }
                score = s;
                mv = m;
                rep_avoid = r;

                if score <= alpha {
                    alpha = (alpha - window).max(-INF_SCORE);
                    window = window.saturating_mul(2);
                } else if score >= beta {
                    beta = (beta + window).min(INF_SCORE);
                    window = window.saturating_mul(2);
                } else {
                    break;
                }

                attempts += 1;
                if attempts >= ASP_MAX_ITERS {
                    alpha = -INF_SCORE;
                    beta = INF_SCORE;
                    let (s2, m2, r2) = search_depth(&mut pos, d, &mut ctx, &mut state.table, &zob, root_hash, alpha, beta, pv_move_hint);
                    if ctx.stop {
                        break;
                    }
                    score = s2;
                    mv = m2;
                    rep_avoid = r2;
                    break;
                }
            }
        } else {
            let (s, m, r) = search_depth(&mut pos, d, &mut ctx, &mut state.table, &zob, root_hash, -INF_SCORE, INF_SCORE, pv_move_hint);
            if ctx.stop {
                break;
            }
            score = s;
            mv = m;
            rep_avoid = r;
        }

        if ctx.stop {
            break;
        }

        best_score = score;
        best_move = mv;
        completed_depth = d;
        rep_avoid_used = rep_avoid;
        last_score = best_score;
        pv_move_hint = best_move.map(|(mv, promo)| (mv.from, mv.to, promo));

        if best_score >= MATE_SCORE - MATE_EARLY_STOP_PLIES {
            break;
        }

        if time_limit_ms > 0.0 && now_ms() - ctx.start_ms >= time_limit_ms {
            break;
        }
    }

    let elapsed_ms = (now_ms() - ctx.start_ms).max(0.0);
    let nps = if elapsed_ms > 0.0 {
        (ctx.nodes as f64 * 1000.0 / elapsed_ms) as u64
    } else {
        0
    };

    let best_str = best_move
        .map(|(mv, promo)| move_to_uci(mv, promo))
        .unwrap_or_else(|| "".to_string());
    let pv_str = if best_str.is_empty() {
        String::new()
    } else {
        let line = build_pv_line(&pos, &state.table, &zob, root_hash, completed_depth, best_move);
        if line.is_empty() { best_str.clone() } else { line }
    };
    let root_eval_field = if debug_root {
        let root_json = root_eval_breakdown_json(&mut pos);
        format!(",\"root_eval\":{}", root_json)
    } else {
        String::new()
    };

    let mut out = format!(
        "{{\"depth\":{},\"nodes\":{},\"time_ms\":{},\"nps\":{},\"score\":{},\"best\":\"{}\",\"pv\":\"{}\",\"rep_avoid\":{}}}",
        completed_depth,
        ctx.nodes,
        elapsed_ms as u64,
        nps,
        best_score,
        best_str,
        pv_str,
        rep_avoid_used
    );
    out.push_str(&root_eval_field);

        state.killers = ctx.killers;
        state.history_heur = ctx.history_heur;

        out
    })
}

// WASM-Export: einfache Suche (Alpha-Beta, Material-Eval).
// Rückgabe ist ein JSON-String für den Worker.
#[wasm_bindgen]
pub fn search(fen: &str, depth: u32, time_ms: u32, tt_mb: u32) -> String {
    search_impl(fen, depth, time_ms, tt_mb, "")
}

// WASM-Export: Suche mit History für echte Repetition-Erkennung.
#[wasm_bindgen]
pub fn search_with_history(fen: &str, depth: u32, time_ms: u32, tt_mb: u32, history: &str) -> String {
    search_impl(fen, depth, time_ms, tt_mb, history)
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
