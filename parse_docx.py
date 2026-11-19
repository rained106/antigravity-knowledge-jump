# -*- coding: utf-8 -*-
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"

_MATRIX_ENV_MAP = {
    ("(", ")"): "pmatrix",
    ("[", "]"): "bmatrix",
    ("{", "}"): "Bmatrix",
    ("|", "|"): "vmatrix",
    ("∣", "∣"): "vmatrix",
    ("‖", "‖"): "Vmatrix",
    ("∥", "∥"): "Vmatrix",
    ("{", ""): "cases",
}

_ACCENT_CMD_MAP = {
    "‾": "\\bar",
    "\u0304": "\\bar",
    "\u0305": "\\bar",
    "¯": "\\bar",
    "\u0307": "\\dot",
    "˙": "\\dot",
    "\u0308": "\\ddot",
    "¨": "\\ddot",
    "\u20d7": "\\vec",
    "→": "\\vec",
    "\u0302": "\\hat",
    "^": "\\hat",
    "ˆ": "\\hat",
    "\u0303": "\\tilde",
    "~": "\\tilde",
    "˜": "\\tilde",
}

_NARY_OP_MAP = {
    "∫": "\\int",
    "∬": "\\iint",
    "∭": "\\iiint",
    "∮": "\\oint",
    "∑": "\\sum",
    "∏": "\\prod",
    "∐": "\\coprod",
    "⋃": "\\bigcup",
    "⋂": "\\bigcap",
}


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _delim_to_latex(ch: str, is_left: bool) -> str:
    if not ch:
        return "."
    if ch == "{":
        return "\\{"
    if ch == "}":
        return "\\}"
    if ch in ("|", "∣"):
        return "\\lvert" if is_left else "\\rvert"
    if ch in ("‖", "∥"):
        return "\\lVert" if is_left else "\\rVert"
    if ch == "⟨":
        return "\\langle"
    if ch == "⟩":
        return "\\rangle"
    return ch


def _matrix_body(m_node) -> str:
    rows = []
    for c in m_node:
        if _local(c.tag) == "mr":
            cells = ["".join(_omml_to_latex(x) for x in cell).strip() for cell in c if _local(cell.tag) == "e"]
            rows.append(" & ".join(cells))
    return " \\\\ ".join(rows)


def _extract_single_matrix(e_nodes):
    if len(e_nodes) != 1:
        return None
    meaningful = []
    for child in e_nodes[0]:
        ln = _local(child.tag)
        if ln in ("ctrlPr", "argPr"):
            continue
        if ln == "r":
            txt = "".join(
                (sub.text or "").replace("\u200b", "")
                for sub in child
                if _local(sub.tag) == "t"
            ).strip()
            if not txt:
                continue
        meaningful.append(child)
    if len(meaningful) == 1 and _local(meaningful[0].tag) == "m":
        return meaningful[0]
    return None


def _plain_text(node) -> str:
    return "".join(
        (t.text or "").replace("\u200b", "")
        for t in node.iter()
        if _local(t.tag) == "t"
    ).strip()


def _format_math_text(raw: str) -> str:
    txt = (raw or "").replace("\u200b", "").replace("\u2001", " \\quad ").replace("\u2005", "\\,")
    # Wrap CJK runs in \text{...} so KaTeX renders Chinese labels cleanly inside equations
    txt = re.sub(r"([\u4e00-\u9fff]+)", r"\\text{\1}", txt)
    return txt


def _omml_to_latex(node) -> str:
    name = _local(node.tag)
    if name == "t":
        return _format_math_text(node.text or "")
    if name == "r":
        return "".join(_omml_to_latex(c) for c in node)
    if name == "m":
        return f"\\begin{{matrix}} {_matrix_body(node)} \\end{{matrix}}"
    if name == "f":
        # Fraction: num / den
        num = ""
        den = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "num":
                num = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "den":
                den = "".join(_omml_to_latex(x) for x in c).strip()
        return f"\\frac{{{num}}}{{{den}}}"
    if name == "sSub":
        base = sub = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "e":
                base = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "sub":
                sub = "".join(_omml_to_latex(x) for x in c).strip()
        return f"{base}_{{{sub}}}"
    if name == "sSup":
        base = sup = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "e":
                base = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "sup":
                sup = "".join(_omml_to_latex(x) for x in c).strip()
        return f"{base}^{{{sup}}}"
    if name == "sSubSup":
        base = sub = sup = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "e":
                base = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "sub":
                sub = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "sup":
                sup = "".join(_omml_to_latex(x) for x in c).strip()
        return f"{base}_{{{sub}}}^{{{sup}}}"
    if name == "rad":
        deg = body = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "deg":
                deg = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "e":
                body = "".join(_omml_to_latex(x) for x in c).strip()
        return f"\\sqrt[{deg}]{{{body}}}" if deg else f"\\sqrt{{{body}}}"
    if name == "acc":
        chr_val = "\u0302"
        body = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "accPr":
                for p in c:
                    if _local(p.tag) == "chr":
                        chr_val = p.get(f"{M_NS}val", chr_val)
            elif ln == "e":
                body = "".join(_omml_to_latex(x) for x in c).strip()
        cmd = _ACCENT_CMD_MAP.get(chr_val, "\\hat")
        return f"{cmd}{{{body}}}"
    if name == "bar":
        pos = "top"
        body = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "barPr":
                for p in c:
                    if _local(p.tag) == "pos":
                        pos = p.get(f"{M_NS}val", "top")
            elif ln == "e":
                body = "".join(_omml_to_latex(x) for x in c).strip()
        cmd = "\\underline" if pos == "bot" else "\\overline"
        return f"{cmd}{{{body}}}"
    if name == "nary":
        op_chr = "∫"
        sub_hide = sup_hide = False
        sub = sup = body = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "naryPr":
                for p in c:
                    pl = _local(p.tag)
                    if pl == "chr":
                        op_chr = p.get(f"{M_NS}val", op_chr)
                    elif pl == "subHide":
                        sub_hide = p.get(f"{M_NS}val", "0") == "1"
                    elif pl == "supHide":
                        sup_hide = p.get(f"{M_NS}val", "0") == "1"
            elif ln == "sub":
                sub = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "sup":
                sup = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "e":
                body = "".join(_omml_to_latex(x) for x in c).strip()
        op = _NARY_OP_MAP.get(op_chr, "\\int")
        sub_part = f"_{{{sub}}}" if (sub and not sub_hide) else ""
        sup_part = f"^{{{sup}}}" if (sup and not sup_hide) else ""
        return f"{op}{sub_part}{sup_part} {body}".strip()
    if name in ("limLow", "limUpp"):
        body = lim_tex = lim_raw = ""
        for c in node:
            ln = _local(c.tag)
            if ln == "e":
                body = "".join(_omml_to_latex(x) for x in c).strip()
            elif ln == "lim":
                lim_raw = _plain_text(c)
                lim_tex = "".join(_omml_to_latex(x) for x in c).strip()
        if name == "limLow":
            if lim_raw in ("⏟", "︸", "⎵", "\u23df"):
                return f"\\underbrace{{{body}}}"
            if body.startswith("\\underbrace{"):
                return f"{body}_{{{lim_tex}}}" if lim_tex else body
            return f"\\underset{{{lim_tex}}}{{{body}}}" if lim_tex else body
        if lim_raw in ("⏞", "︷", "\u23de"):
            return f"\\overbrace{{{body}}}"
        if body.startswith("\\overbrace{"):
            return f"{body}^{{{lim_tex}}}" if lim_tex else body
        return f"\\overset{{{lim_tex}}}{{{body}}}" if lim_tex else body
    if name == "eqArr":
        lines = ["".join(_omml_to_latex(x) for x in c).strip() for c in node if _local(c.tag) == "e"]
        return f"\\begin{{aligned}} {' \\\\ '.join(lines)} \\end{{aligned}}"
    if name == "d":
        beg = "("
        end = ")"
        e_nodes = []
        for c in node:
            ln = _local(c.tag)
            if ln == "dPr":
                for p in c:
                    pl = _local(p.tag)
                    if pl == "begChr":
                        beg = p.get(f"{M_NS}val", "(")
                    elif pl == "endChr":
                        end = p.get(f"{M_NS}val", ")")
            elif ln == "e":
                e_nodes.append(c)
        m_node = _extract_single_matrix(e_nodes)
        if m_node is not None:
            body = _matrix_body(m_node)
            env = _MATRIX_ENV_MAP.get((beg, end))
            if env:
                return f"\\begin{{{env}}} {body} \\end{{{env}}}"
            lb = _delim_to_latex(beg, True)
            rb = _delim_to_latex(end, False)
            return f"\\left{lb} \\begin{{matrix}} {body} \\end{{matrix}} \\right{rb}"
        inner = ["".join(_omml_to_latex(x) for x in e).strip() for e in e_nodes]
        joined = ", ".join(inner)
        if beg == "(" and end == ")" and not any(k in joined for k in ("\\frac", "\\begin{", "\\int", "\\sum")):
            return f"({joined})"
        return f"\\left{_delim_to_latex(beg, True)} {joined} \\right{_delim_to_latex(end, False)}"
    if name in (
        "rPr", "ctrlPr", "fPr", "sSubPr", "sSupPr", "sSubSupPr", "radPr",
        "oMathPr", "accPr", "barPr", "naryPr", "limLowPr", "limUppPr", "mPr", "eqArrPr"
    ):
        return ""
    return "".join(_omml_to_latex(c) for c in node)


def _extract_paragraph_text(p_elem) -> str:
    parts = []
    for child in p_elem:
        ln = _local(child.tag)
        if ln == "r":
            for sub in child:
                if _local(sub.tag) == "t" and sub.text:
                    parts.append(sub.text)
                elif _local(sub.tag) == "tab":
                    parts.append(" ")
        elif ln == "oMath":
            latex = _omml_to_latex(child).strip()
            if latex:
                parts.append(f"${latex}$")
        elif ln == "oMathPara":
            inner = " ".join(_omml_to_latex(c).strip() for c in child if _local(c.tag) == "oMath").strip()
            if inner:
                parts.append(f"$${inner}$$")
        elif ln == "hyperlink":
            parts.append(_extract_paragraph_text(child))
    return "".join(parts).strip()


def _load_style_names(zf: zipfile.ZipFile) -> dict:
    style_map = {}
    if "word/styles.xml" not in zf.namelist():
        return style_map
    try:
        root = ET.fromstring(zf.read("word/styles.xml"))
        for st in root.findall(f"{W_NS}style"):
            sid = st.get(f"{W_NS}styleId")
            nm = st.find(f"{W_NS}name")
            if sid and nm is not None:
                val = nm.get(f"{W_NS}val", "")
                if val:
                    style_map[sid] = val
    except Exception:
        pass
    return style_map


def _paragraph_heading_prefix(p_elem, style_map: dict) -> str:
    p_pr = p_elem.find(f"{W_NS}pPr")
    if p_pr is None:
        return ""
    p_style = p_pr.find(f"{W_NS}pStyle")
    if p_style is None:
        return ""
    sid = p_style.get(f"{W_NS}val", "")
    name = (style_map.get(sid, sid) or "").strip()
    low = name.lower()
    if low == "title":
        return "# "
    if low == "subtitle":
        return "## "
    m = re.match(r"^(?:heading|标题)\s*(\d+)$", low)
    if m:
        lvl = min(4, max(1, int(m.group(1))))
        return "#" * lvl + " "
    return ""


def extract_docx_lines(path: str):
    lines = []
    with zipfile.ZipFile(path, "r") as zf:
        style_map = _load_style_names(zf)
        doc_root = ET.fromstring(zf.read("word/document.xml"))
    body = doc_root.find(f"{W_NS}body")
    if body is None:
        return lines

    for block in body:
        tag = _local(block.tag)
        if tag == "p":
            txt = _extract_paragraph_text(block)
            if not txt:
                continue
            prefix = _paragraph_heading_prefix(block, style_map)
            lines.append(f"{prefix}{txt}")
        elif tag == "tbl":
            rows = [r for r in block if _local(r.tag) == "tr"]
            for r_idx, row in enumerate(rows):
                cells = []
                for tc in row:
                    if _local(tc.tag) != "tc":
                        continue
                    cell_txt = " ".join(
                        _extract_paragraph_text(p) for p in tc if _local(p.tag) == "p"
                    ).strip()
                    cells.append(cell_txt)
                lines.append("| " + " | ".join(cells) + " |")
                if r_idx == 0:
                    lines.append("| " + " | ".join(["---"] * len(cells)) + " |")
    return lines


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("[]")
        sys.exit(0)
    out = extract_docx_lines(sys.argv[1])
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))
