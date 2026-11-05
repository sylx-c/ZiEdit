//! compare/detect —— 六类差异检测底座（008 规则 6，ADR 010）
//! 纯函数集合：码点级分类 + 不可见字符扫描；供 compare_detail 与 002 不可见字符高亮共用。
//! 分类优先级（一个变更 run 只归一类）：规范化 > 隐藏字符 > 同形异码 > 行尾空白 > 普通内容。
//! 编码差异与 BOM 在行级/文件级判定（mod.rs），不在此处。

use unicode_normalization::UnicodeNormalization;

/// 差异类别（serde camelCase 序列化到前端）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpanCat {
    /// 同形异码：视觉相同但码位不同（拉丁 a / 西里尔 а 等）
    Homoglyph,
    /// 规范化：NFC 归一后相同（é 单码点 vs e+组合重音符）
    Normalize,
    /// 隐藏字符：零宽类 / 控制符 / 行中 BOM / RTL 控制符
    Invisible,
    /// 行尾/空白类别差异（Tab/空格/全角空格/NBSP）
    Whitespace,
    /// 普通内容差异
    Content,
}

/// 一个分段的两侧文本与类别（全行分段：等值段 eq=true，变更段带类别）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanText {
    pub text_a: String,
    pub text_b: String,
    pub cat: SpanCat,
    #[serde(default)]
    pub eq: bool,
}

/// 内置 confusables 精简表（Unicode confusables 高频子集：西里尔/希腊/全角已由 NFKC 覆盖）
const CONFUSABLES: &[(char, char)] = &[
    ('а', 'a'),
    ('е', 'e'),
    ('о', 'o'),
    ('р', 'p'),
    ('с', 'c'),
    ('у', 'y'),
    ('х', 'x'),
    ('і', 'i'),
    ('ј', 'j'),
    ('һ', 'h'),
    ('ԁ', 'd'),
    ('ɡ', 'g'),
    ('ν', 'v'),
    ('α', 'a'),
    ('ο', 'o'),
    ('ρ', 'p'),
    ('τ', 't'),
    ('υ', 'u'),
    ('χ', 'x'),
    ('ι', 'i'),
    ('κ', 'k'),
    ('ⅼ', 'l'),
    ('ⅼ', 'l'),
    ('０', '0'),
    ('１', '1'),
    ('；', ';'),
    ('：', ':'),
    ('！', '!'),
    ('（', '('),
    ('）', ')'),
    ('【', '['),
    ('】', ']'),
    ('《', '<'),
    ('》', '>'),
    ('“', '"'),
    ('”', '"'),
    ('‘', '\''),
    ('’', '\''),
];

/// 归一到"视觉等价形"：NFKC（全角→半角等）+ confusables 表映射
fn visual_form(s: &str) -> String {
    s.nfkc()
        .map(|c| {
            for &(from, to) in CONFUSABLES {
                if c == from {
                    return to;
                }
            }
            c
        })
        .collect::<String>()
        .to_lowercase()
}

/// 零宽/隐藏字符判定（002 规则 25 同一底座）
pub fn is_invisible_char(c: char) -> bool {
    let u = c as u32;
    // 零宽类：ZWSP/ZWNJ/ZWJ/ZWWJ/FEFF(含行中 BOM)；双向控制：202A-202E/2066-2069；其他控制（除 \t）
    matches!(u, 0x200B..=0x200F | 0x2060 | 0xFEFF | 0x202A..=0x202E | 0x2066..=0x2069)
        || (c.is_control() && c != '\t')
}

fn has_invisible(s: &str) -> bool {
    s.chars().any(is_invisible_char)
}

fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\u{3000}' | '\u{00A0}' | '\u{FEFF}')
}

/// run 对分类
fn classify_run(a: &str, b: &str) -> SpanCat {
    if a.nfc().eq(b.nfc()) {
        return SpanCat::Normalize;
    }
    if has_invisible(a) || has_invisible(b) {
        return SpanCat::Invisible;
    }
    if !a.is_empty() && !b.is_empty() && visual_form(a) == visual_form(b) {
        return SpanCat::Homoglyph;
    }
    if a.chars().all(is_ws) && b.chars().all(is_ws) {
        return SpanCat::Whitespace;
    }
    SpanCat::Content
}

/// 行内码点级差异：对 a/b 两行做字符 diff，返回**全行分段**
/// （等值段 eq=true；变更段带类别。前端按序拼回整行，避免码点索引换算）
pub fn classify_line_pair(a: &str, b: &str) -> Vec<SpanText> {
    let diff = similar::TextDiff::from_chars(a, b);
    let run = |s: &str, r: std::ops::Range<usize>| -> String {
        s.chars().skip(r.start).take(r.end - r.start).collect()
    };
    let mut out = Vec::new();
    for op in diff.ops() {
        match op.tag() {
            similar::DiffTag::Equal => {
                let ra = run(a, op.old_range());
                let rb = run(b, op.new_range());
                out.push(SpanText {
                    text_a: ra,
                    text_b: rb,
                    cat: SpanCat::Content,
                    eq: true,
                });
            }
            similar::DiffTag::Replace => {
                let ra = run(a, op.old_range());
                let rb = run(b, op.new_range());
                let cat = classify_run(&ra, &rb);
                out.push(SpanText {
                    text_a: ra,
                    text_b: rb,
                    cat,
                    eq: false,
                });
            }
            similar::DiffTag::Delete => {
                let ra = run(a, op.old_range());
                let cat = classify_run(&ra, "");
                out.push(SpanText {
                    text_a: ra,
                    text_b: String::new(),
                    cat,
                    eq: false,
                });
            }
            similar::DiffTag::Insert => {
                let rb = run(b, op.new_range());
                let cat = classify_run("", &rb);
                out.push(SpanText {
                    text_a: String::new(),
                    text_b: rb,
                    cat,
                    eq: false,
                });
            }
        }
    }
    out
}

/// 不可见字符扫描（002 高亮用）：返回 (起点字符数, 文本) 片段
pub fn invisible_spans(line: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in line.chars().enumerate() {
        if is_invisible_char(c) {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start.take() {
            out.push((s, line.chars().skip(s).take(i - s).collect()));
        }
    }
    if let Some(s) = start {
        out.push((s, line.chars().skip(s).collect()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cats(spans: &[SpanText]) -> Vec<SpanCat> {
        spans.iter().map(|s| s.cat).collect()
    }

    #[test]
    fn cat_normalize() {
        // é(NFC U+00E9) vs e+U+0301
        let a = "caf\u{00E9}";
        let b = "cafe\u{0301}";
        assert!(cats(&classify_line_pair(a, b)).contains(&SpanCat::Normalize));
    }

    #[test]
    fn cat_homoglyph() {
        let a = "user аdmin"; // 西里尔 а
        let b = "user admin"; // 拉丁 a
        let spans = classify_line_pair(a, b);
        assert!(
            cats(&spans).contains(&SpanCat::Homoglyph),
            "{:?}",
            cats(&spans)
        );
    }

    #[test]
    fn cat_invisible() {
        let a = "abc";
        let b = "ab\u{200B}c"; // 零宽空格
        assert!(cats(&classify_line_pair(a, b)).contains(&SpanCat::Invisible));
    }

    #[test]
    fn cat_whitespace() {
        let a = "x\ty";
        let b = "x y";
        assert!(cats(&classify_line_pair(a, b)).contains(&SpanCat::Whitespace));
    }

    #[test]
    fn cat_plain() {
        assert!(cats(&classify_line_pair("foo", "bar")).contains(&SpanCat::Content));
    }

    #[test]
    fn invisible_scan() {
        let spans = invisible_spans("a\u{200B}b\u{202E}c");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].1, "\u{200B}");
    }
}
