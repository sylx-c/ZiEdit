//! compare/xdiff —— xlsx 结构化差异（批 3：单元格级清单，Excel「Spreadsheet
//! Compare」的差异清单交互形态参考、实现原创）。
//! 与行投影 diff 的分工：投影 diff 回答「哪些行变了」（Myers 对齐 + 行内高亮）；
//! xdiff 回答「哪个格子/哪行/哪表变了」（Sheet2!C5: 100→200），可点击定位。
//!
//! 行对齐：默认按行号配对（与批 1 投影语义一致——投影行不含行号的原因见
//! compare::office）；键列模式用 diff_hashes 对键列做 Myers 对齐（指定键列后
//! 插入行不再引起后续错位——总目标判据 3）。
//!
//! 纯函数、不依赖 tauri 运行时（compare 模块同一红线）；确定性：同一对
//! Workbook 输出逐字节一致的差异序列（单测锁定）。

use super::office::sanitize_cell;
use super::{LineHash, diff_hashes, hash_of};
use crate::ooxml::xlsx::{Sheet, Workbook};

/// 差异总量上限哨兵：超限显式报错不静默截断（清单是交互载荷，2 万条已远超
/// 可浏览范围；行投影 diff 不受限，两条通道各司其职）
pub const XLSX_DIFF_LIMIT: usize = 20_000;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDiff {
    /// 所在 sheet 名
    pub sheet: String,
    /// cell | rowAdd | rowDel | sheetAdd | sheetDel
    pub kind: &'static str,
    /// 1 基行号（rowAdd/rowDel 为区间首行）
    pub row: u64,
    /// rowAdd/rowDel 的行数（cell 恒 1）
    pub rows: u64,
    /// 0 基列号（cell 差异专用；行/表级为 0）
    pub col: u32,
    /// A 侧显示值（sheetDel 时为空）
    pub before: String,
    /// B 侧显示值（sheetAdd 时为空）
    pub after: String,
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxDiffOpts {
    /// 键列（1 基）；Some 时按该列值做 Myers 行对齐
    #[serde(default)]
    pub key_column: Option<u32>,
}

/// 键列行哈希（键列格的显示值 → 行哈希；空行以空串哈希占位保持可对齐）
fn key_hashes(sheet: &Sheet, key: u32) -> Vec<LineHash> {
    let col = (key - 1) as usize;
    sheet
        .records
        .iter()
        .map(|row| {
            let v = row.get(col).cloned().unwrap_or_default();
            LineHash {
                byte: hash_of(&v),
                text: hash_of(&v),
            }
        })
        .collect()
}

/// 同名 sheet 配对：A 独有 → sheetDel；B 独有 → sheetAdd；其余按名配对。
/// 配对顺序按 A 的 sheet 序（B 中未配对项按 B 序补在后面——确定性）。
fn pair_sheets(a: &Workbook, b: &Workbook) -> Vec<(Option<usize>, Option<usize>)> {
    let mut pairs = Vec::new();
    let mut used_b = vec![false; b.sheets.len()];
    for (ai, sa) in a.sheets.iter().enumerate() {
        match b
            .sheets
            .iter()
            .position(|sb| !sb.name.is_empty() && sb.name == sa.name)
        {
            Some(bi) if !used_b[bi] => {
                used_b[bi] = true;
                pairs.push((Some(ai), Some(bi)));
            }
            _ => pairs.push((Some(ai), None)),
        }
    }
    for (bi, used) in used_b.iter().enumerate() {
        if !used {
            pairs.push((None, Some(bi)));
        }
    }
    pairs
}

/// 单 sheet 差异：行对齐（键列模式）→ 逐坐标比单元格。
/// 默认模式行号配对（i↔i）；键列模式对键列哈希做 Myers，等值块内配对、
/// delete→rowDel / insert→rowAdd。
fn diff_sheet(
    out: &mut Vec<CellDiff>,
    sheet: &str,
    a: &Sheet,
    b: &Sheet,
    opts: &XlsxDiffOpts,
) -> Result<(), String> {
    enum Align {
        Pair(usize, usize),
        Del(usize),
        Add(usize),
    }
    let align: Vec<Align> = match opts.key_column {
        None => (0..a.records.len().max(b.records.len()))
            .map(|i| {
                if i < a.records.len() && i < b.records.len() {
                    Align::Pair(i, i)
                } else if i < a.records.len() {
                    Align::Del(i)
                } else {
                    Align::Add(i)
                }
            })
            .collect(),
        Some(key) => {
            let ha = key_hashes(a, key);
            let hb = key_hashes(b, key);
            let mut items: Vec<Align> = Vec::new();
            for blk in diff_hashes(&ha, &hb) {
                match blk.kind.as_str() {
                    "equal" => {
                        for k in 0..=(blk.a_end - blk.a_start) {
                            items.push(Align::Pair(
                                (blk.a_start + k - 1) as usize,
                                (blk.b_start + k - 1) as usize,
                            ));
                        }
                    }
                    "delete" => {
                        for x in blk.a_start..=blk.a_end {
                            items.push(Align::Del((x - 1) as usize));
                        }
                    }
                    "insert" => {
                        for y in blk.b_start..=blk.b_end {
                            items.push(Align::Add((y - 1) as usize));
                        }
                    }
                    // replace：等长段两两配对，A 多出的尾行走 Del、B 多出的走 Add
                    _ => {
                        let n = (blk.a_end - blk.a_start + 1).min(blk.b_end - blk.b_start + 1);
                        for k in 0..n {
                            items.push(Align::Pair(
                                (blk.a_start + k - 1) as usize,
                                (blk.b_start + k - 1) as usize,
                            ));
                        }
                        for x in blk.a_start + n..=blk.a_end {
                            items.push(Align::Del((x - 1) as usize));
                        }
                        for y in blk.b_start + n..=blk.b_end {
                            items.push(Align::Add((y - 1) as usize));
                        }
                    }
                }
            }
            items
        }
    };
    for item in align {
        // 总量哨兵下沉到推送循环（批 6 复验）：修前只在每个 sheet 配对后检查，
        // 单 sheet 可在报错前累积数十万条（约 20× 哨兵意图的峰值内存）。
        // 语义：恰好 2 万条可接受，出现第 20001 条即报错（审查 L4：循环内用 >=
        // 保证峰值恰为上限；收尾检查保留 > 以放行恰好上限的清单）。
        if out.len() >= XLSX_DIFF_LIMIT {
            return Err(format!("XLSX_DIFF_LIMIT:{}", XLSX_DIFF_LIMIT));
        }
        match item {
            Align::Pair(ia, ib) => {
                let ra = &a.records[ia];
                let rb = &b.records[ib];
                let width = ra.len().max(rb.len());
                for c in 0..width {
                    let va = ra.get(c).cloned().unwrap_or_default();
                    let vb = rb.get(c).cloned().unwrap_or_default();
                    if va != vb {
                        out.push(CellDiff {
                            sheet: sheet.into(),
                            kind: "cell",
                            row: ia as u64 + 1,
                            rows: 1,
                            col: c as u32,
                            before: sanitize_cell(&va),
                            after: sanitize_cell(&vb),
                        });
                    }
                }
            }
            Align::Del(ia) => {
                let text = a.records[ia].join("\t");
                out.push(CellDiff {
                    sheet: sheet.into(),
                    kind: "rowDel",
                    row: ia as u64 + 1,
                    rows: 1,
                    col: 0,
                    before: sanitize_cell(&text),
                    after: String::new(),
                });
            }
            Align::Add(ib) => {
                let text = b.records[ib].join("\t");
                out.push(CellDiff {
                    sheet: sheet.into(),
                    kind: "rowAdd",
                    row: ib as u64 + 1,
                    rows: 1,
                    col: 0,
                    before: String::new(),
                    after: sanitize_cell(&text),
                });
            }
        }
    }
    Ok(())
}

/// 结构化差异主入口（纯函数）。sheet 增删先报，再按配对逐 sheet 出清单。
pub fn xlsx_diff(a: &Workbook, b: &Workbook, opts: &XlsxDiffOpts) -> Result<Vec<CellDiff>, String> {
    if opts.key_column == Some(0) {
        // 1 基键列入口哨兵（批 6 复验）：0 在 key_hashes 会 u32 下溢——debug 构建
        // panic（经 JoinError 变 task panicked），release 回绕后 row.get 恒 None、
        // 全部键哈希退化为空串并静默变成行号配对。显式报错，绝不静默。
        return Err("XLSX_KEY_COLUMN:>=1".into());
    }
    let mut out = Vec::new();
    for (ai, bi) in pair_sheets(a, b) {
        match (ai, bi) {
            (Some(ai), Some(bi)) => diff_sheet(
                &mut out,
                &a.sheets[ai].name,
                &a.sheets[ai],
                &b.sheets[bi],
                opts,
            )?,
            (Some(ai), None) => out.push(CellDiff {
                sheet: a.sheets[ai].name.clone(),
                kind: "sheetDel",
                row: 0,
                rows: a.sheets[ai].records.len() as u64,
                col: 0,
                before: String::new(),
                after: String::new(),
            }),
            (None, Some(bi)) => out.push(CellDiff {
                sheet: b.sheets[bi].name.clone(),
                kind: "sheetAdd",
                row: 0,
                rows: b.sheets[bi].records.len() as u64,
                col: 0,
                before: String::new(),
                after: String::new(),
            }),
            (None, None) => unreachable!(),
        }
        if out.len() > XLSX_DIFF_LIMIT {
            return Err(format!("XLSX_DIFF_LIMIT:{}", XLSX_DIFF_LIMIT));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ooxml::xlsx::Sheet;

    fn sheet(name: &str, rows: Vec<Vec<&str>>) -> Sheet {
        Sheet {
            name: name.into(),
            records: rows
                .into_iter()
                .map(|r| r.into_iter().map(String::from).collect())
                .collect(),
            formulas: Vec::new(),
            merges: Vec::new(),
        }
    }
    fn book(sheets: Vec<Sheet>) -> Workbook {
        Workbook {
            sheets,
            is_1904: false,
        }
    }

    #[test]
    fn cell_diff_by_coordinate() {
        // 改一格 = 恰好一条 cell 差异（Sheet2!C5 形态，0 基列 2）
        let a = book(vec![sheet(
            "S",
            vec![vec!["h", "h"], vec!["1", "100"], vec!["2", "x"]],
        )]);
        let b = book(vec![sheet(
            "S",
            vec![vec!["h", "h"], vec!["1", "200"], vec!["2", "x"]],
        )]);
        let d = xlsx_diff(&a, &b, &XlsxDiffOpts::default()).unwrap();
        assert_eq!(
            d,
            vec![CellDiff {
                sheet: "S".into(),
                kind: "cell",
                row: 2,
                rows: 1,
                col: 1,
                before: "100".into(),
                after: "200".into(),
            }]
        );
    }

    #[test]
    fn sheet_add_del_and_row_add_del() {
        let a = book(vec![
            sheet("Both", vec![vec!["1"], vec!["gone"]]),
            sheet("OnlyA", vec![vec!["x"]]),
        ]);
        let b = book(vec![
            sheet("Both", vec![vec!["1"]]),
            sheet("OnlyB", vec![vec!["y"]]),
        ]);
        let d = xlsx_diff(&a, &b, &XlsxDiffOpts::default()).unwrap();
        let kinds: Vec<(&str, &str)> = d.iter().map(|x| (x.kind, x.sheet.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                ("rowDel", "Both"),
                ("sheetDel", "OnlyA"),
                ("sheetAdd", "OnlyB")
            ]
        );
        assert_eq!(d[0].row, 2);
        assert_eq!(d[0].before, "gone");
        assert_eq!(d[1].rows, 1);
    }

    #[test]
    fn key_column_absorbs_row_insertion() {
        // 判据 3：B 在开头插入一行，默认行号对齐 → 全后续错位（行投影同理由 Myers
        // 吸收；xdiff 默认模式如实按行号报），键列模式 → 仅 rowAdd 一条
        let a = book(vec![sheet(
            "S",
            vec![vec!["k1", "v1"], vec!["k2", "v2"], vec!["k3", "v3"]],
        )]);
        let mut rows = vec![
            vec!["k0", "v0"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
        ];
        rows.extend(a.sheets[0].records.clone());
        let b = book(vec![Sheet {
            records: rows,
            ..sheet("S", vec![])
        }]);
        let plain = xlsx_diff(&a, &b, &XlsxDiffOpts::default()).unwrap();
        assert!(
            plain.len() > 3,
            "行号对齐如实放大（指导用户用键列）: {:?}",
            plain
        );
        let keyed = xlsx_diff(
            &a,
            &b,
            &XlsxDiffOpts {
                key_column: Some(1),
            },
        )
        .unwrap();
        assert_eq!(keyed.len(), 1, "{:?}", keyed);
        assert_eq!(keyed[0].kind, "rowAdd");
        assert_eq!(keyed[0].row, 1);
        assert_eq!(
            keyed[0].after, "k0\u{21E5}v0",
            "行文本按投影同款字面量化（⇥）保持单行"
        );
        // 键列值变化 + 后续行不变：恰好一格差异
        let c = book(vec![sheet(
            "S",
            vec![vec!["k1", "V1"], vec!["k2", "v2"], vec!["k3", "v3"]],
        )]);
        let keyed2 = xlsx_diff(
            &a,
            &c,
            &XlsxDiffOpts {
                key_column: Some(1),
            },
        )
        .unwrap();
        assert_eq!(keyed2.len(), 1);
        assert_eq!(
            (keyed2[0].kind, keyed2[0].row, keyed2[0].col),
            ("cell", 1, 1)
        );
    }

    #[test]
    fn determinism_and_limit_sentinel() {
        let rows = |v: &str| {
            (0..100)
                .map(|i| vec![i.to_string(), v.to_string()])
                .collect::<Vec<Vec<String>>>()
        };
        let mk = |v: &str| {
            book(vec![Sheet {
                records: rows(v),
                ..sheet("S", vec![])
            }])
        };
        let a = mk("x");
        let b = mk("y");
        let d1 = xlsx_diff(&a, &b, &XlsxDiffOpts::default()).unwrap();
        let d2 = xlsx_diff(&a, &b, &XlsxDiffOpts::default()).unwrap();
        assert_eq!(d1, d2, "确定性：同输入逐字节一致");
        assert_eq!(d1.len(), 100);
        // 超限哨兵：>2 万条差异显式报错
        let big = {
            let mut s = sheet("S", vec![]);
            s.records = (0..21_000)
                .map(|i| vec![i.to_string(), "x".into()])
                .collect();
            book(vec![s])
        };
        let bigger = {
            let mut s = sheet("S", vec![]);
            s.records = (0..21_000)
                .map(|i| vec![i.to_string(), "z".into()])
                .collect();
            book(vec![s])
        };
        assert_eq!(
            xlsx_diff(&big, &bigger, &XlsxDiffOpts::default())
                .err()
                .unwrap(),
            "XLSX_DIFF_LIMIT:20000"
        );
    }

    #[test]
    fn key_column_zero_is_rejected() {
        // 批 6 复验：1 基键列 0 修前在 key_hashes u32 下溢——debug panic /
        // release 静默退化为行号配对；入口显式哨兵
        let a = book(vec![sheet("S", vec![vec!["k"], vec!["x"]])]);
        let b = book(vec![sheet("S", vec![vec!["k"], vec!["y"]])]);
        assert_eq!(
            xlsx_diff(
                &a,
                &b,
                &XlsxDiffOpts {
                    key_column: Some(0)
                }
            )
            .err()
            .unwrap(),
            "XLSX_KEY_COLUMN:>=1"
        );
    }
}
