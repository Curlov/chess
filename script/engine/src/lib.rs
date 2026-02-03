use wasm_bindgen::prelude::*;

#[inline]
fn bb(sq: u8) -> u64 {
    1u64 << sq
}

#[inline]
fn lsb_idx(x: u64) -> usize {
    debug_assert!(x != 0);
    x.trailing_zeros() as usize
}

#[inline]
fn msb_idx(x: u64) -> usize {
    debug_assert!(x != 0);
    (63 - (x.leading_zeros() as u32)) as usize
}

// ----------------------
// Ray-Generatoren (const)
// ----------------------
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
const fn build_ne() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_ne_from(i as u8);
        i += 1;
    }
    a
}
const fn build_nw() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_nw_from(i as u8);
        i += 1;
    }
    a
}
const fn build_se() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_se_from(i as u8);
        i += 1;
    }
    a
}
const fn build_sw() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_sw_from(i as u8);
        i += 1;
    }
    a
}
const fn build_n() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_n_from(i as u8);
        i += 1;
    }
    a
}
const fn build_s() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_s_from(i as u8);
        i += 1;
    }
    a
}
const fn build_e() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = ray_e_from(i as u8);
        i += 1;
    }
    a
}
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

const fn build_king() -> [u64; 64] {
    let mut a = [0; 64];
    let mut i = 0;
    while i < 64 {
        a[i] = king_attack_from(i as u8);
        i += 1;
    }
    a
}

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
// Clipping (erste Blockerbox)
// ---------------------------
#[inline]
fn clip_forward(ray_from_sq: u64, occ_on_ray: u64, table: &[u64; 64]) -> u64 {
    if occ_on_ray == 0 {
        return ray_from_sq;
    }
    let b = lsb_idx(occ_on_ray);
    ray_from_sq ^ table[b]
}

#[inline]
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
fn bishop_attacks(sq: u8, occ: u64) -> u64 {
    let i = sq as usize;
    let ne = clip_forward(RAY_NE[i], occ & RAY_NE[i], &RAY_NE);
    let nw = clip_forward(RAY_NW[i], occ & RAY_NW[i], &RAY_NW);
    let se = clip_backward(RAY_SE[i], occ & RAY_SE[i], &RAY_SE);
    let sw = clip_backward(RAY_SW[i], occ & RAY_SW[i], &RAY_SW);
    ne | nw | se | sw
}

#[inline]
fn rook_attacks(sq: u8, occ: u64) -> u64 {
    let i = sq as usize;
    let n = clip_forward(RAY_N[i], occ & RAY_N[i], &RAY_N);
    let e = clip_forward(RAY_E[i], occ & RAY_E[i], &RAY_E);
    let s = clip_backward(RAY_S[i], occ & RAY_S[i], &RAY_S);
    let w = clip_backward(RAY_W[i], occ & RAY_W[i], &RAY_W);
    n | e | s | w
}

#[inline]
fn queen_attacks(sq: u8, occ: u64) -> u64 {
    bishop_attacks(sq, occ) | rook_attacks(sq, occ)
}

#[inline]
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

#[inline]
fn pawn_moves(field: u8, occ: u64, own: u64, is_white: bool) -> u64 {
    let mut moves = 0u64;
    let f = (field % 8) as i8;
    let rank = (field / 8) as i8;
    let enemy = occ & !own;

    if is_white {
        let one = field as i16 + 8;
        if one < 64 {
            let one_sq = one as u8;
            if (occ & bb(one_sq)) == 0 {
                moves |= bb(one_sq);
                if rank == 1 {
                    let two = field as i16 + 16;
                    if two < 64 {
                        let two_sq = two as u8;
                        if (occ & bb(two_sq)) == 0 {
                            moves |= bb(two_sq);
                        }
                    }
                }
            }
        }

        if f > 0 {
            let cap = field as i16 + 7;
            if cap < 64 {
                let cap_sq = cap as u8;
                if (enemy & bb(cap_sq)) != 0 {
                    moves |= bb(cap_sq);
                }
            }
        }
        if f < 7 {
            let cap = field as i16 + 9;
            if cap < 64 {
                let cap_sq = cap as u8;
                if (enemy & bb(cap_sq)) != 0 {
                    moves |= bb(cap_sq);
                }
            }
        }
    } else {
        let one = field as i16 - 8;
        if one >= 0 {
            let one_sq = one as u8;
            if (occ & bb(one_sq)) == 0 {
                moves |= bb(one_sq);
                if rank == 6 {
                    let two = field as i16 - 16;
                    if two >= 0 {
                        let two_sq = two as u8;
                        if (occ & bb(two_sq)) == 0 {
                            moves |= bb(two_sq);
                        }
                    }
                }
            }
        }

        if f > 0 {
            let cap = field as i16 - 9;
            if cap >= 0 {
                let cap_sq = cap as u8;
                if (enemy & bb(cap_sq)) != 0 {
                    moves |= bb(cap_sq);
                }
            }
        }
        if f < 7 {
            let cap = field as i16 - 7;
            if cap >= 0 {
                let cap_sq = cap as u8;
                if (enemy & bb(cap_sq)) != 0 {
                    moves |= bb(cap_sq);
                }
            }
        }
    }

    moves
}

// ---------------------------
// WASM Exports
// ---------------------------
#[wasm_bindgen]
pub fn get_valid_moves(fen: &str, field: u8) -> Vec<u8> {
    let board = match fen_to_board(fen) {
        Some(b) => b,
        None => return Vec::new(),
    };

    let idx = field as usize;
    if idx >= 64 {
        return Vec::new();
    }

    let piece = match board[idx] {
        Some(p) => p,
        None => return Vec::new(),
    };

    let is_white_piece = piece.is_ascii_uppercase();
    let mut occ: u64 = 0;
    let mut own: u64 = 0;

    for (i, p) in board.iter().enumerate() {
        if let Some(ch) = p {
            occ |= bb(i as u8);
            if ch.is_ascii_uppercase() == is_white_piece {
                own |= bb(i as u8);
            }
        }
    }

    let attacks = match piece {
        'K' | 'k' => KING_ATTACKS[idx],
        'Q' | 'q' => queen_attacks(field, occ),
        'B' | 'b' => bishop_attacks(field, occ),
        'N' | 'n' => KNIGHT_ATTACKS[idx],
        'R' | 'r' => rook_attacks(field, occ),
        'P' | 'p' => pawn_moves(field, occ, own, is_white_piece),
        _ => 0,
    };

    let targets = attacks & !own;
    bitboard_to_vec(targets)
}

#[wasm_bindgen]
pub fn apply_move(fen: &str, from: u8, to: u8) -> String {
    let parts: Vec<&str> = fen.split_whitespace().collect();
    if parts.len() < 4 {
        return fen.to_string();
    }

    let board_part = parts[0];
    let side_to_move = parts[1];
    let halfmove_str = parts.get(4).copied().unwrap_or("0");
    let fullmove_str = parts.get(5).copied().unwrap_or("1");

    let mut board = match fen_board_to_array(board_part) {
        Some(b) => b,
        None => return fen.to_string(),
    };

    let from_idx = from as usize;
    let to_idx = to as usize;
    if from_idx >= 64 || to_idx >= 64 {
        return fen.to_string();
    }

    let piece = match board[from_idx] {
        Some(p) => p,
        None => return fen.to_string(),
    };

    let is_capture = board[to_idx].is_some();
    let is_pawn_move = piece.to_ascii_lowercase() == 'p';

    board[to_idx] = Some(piece);
    board[from_idx] = None;

    let new_board_part = board_to_fen(&board);
    let new_side = if side_to_move == "w" { "b" } else { "w" };

    let mut halfmove = halfmove_str.parse::<u32>().unwrap_or(0);
    if is_pawn_move || is_capture {
        halfmove = 0;
    } else {
        halfmove += 1;
    }

    let mut fullmove = fullmove_str.parse::<u32>().unwrap_or(1);
    if side_to_move == "b" {
        fullmove += 1;
    }

    let new_castling = "-";
    let new_ep = "-";

    format!(
        "{} {} {} {} {} {}",
        new_board_part, new_side, new_castling, new_ep, halfmove, fullmove
    )
}

// ---------------------------
// FEN Helper
// ---------------------------
fn fen_to_board(fen: &str) -> Option<[Option<char>; 64]> {
    let board_part = fen.split_whitespace().next()?;
    fen_board_to_array(board_part)
}

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
