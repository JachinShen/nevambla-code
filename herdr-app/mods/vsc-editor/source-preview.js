import { div } from "gpui-kit";
import { v_virtual_list, h_flex, Scrollbar } from "gpui-base";
import { highlightSource, displayRow } from "./source-syntax.js";

const LINE_H = 22;

export class SourcePreview {
  constructor(file, language, syntax, font) {
    this.id = `source-${file.path}`;
    this.language = language;
    this.syntax = syntax;
    this.font = font;
  }

  update(text) {
    if (text === this.text) return;
    this.text = text;
    try {
      this.rows = highlightSource(text, this.language.id).map(displayRow);
      this.gutter = Math.max(44, String(this.rows.length).length * 8 + 20);
      const columns = this.rows.reduce((longest, row) => Math.max(longest, row.reduce((n, piece) => {
        for (const char of piece.text) n += char.codePointAt(0) > 255 ? 2 : 1;
        return n;
      }, 0)), 0);
      this.width = Math.max(300, columns * 8 + this.gutter + 24);
      this.error = null;
    } catch (error) {
      this.rows = [];
      this.error = `Cannot highlight ${this.language.name}: ${error.message ?? error}. Use Edit to open the source.`;
    }
  }

  render(t) {
    if (this.error) return div().flex_1().min_h(0).p(16).text_color(t.ansi1).child(this.error);
    return div().flex_1().min_h(0).relative().font_family(this.font).text_size(13)
      .child(div().id(`${this.id}-x`).size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.width).h_full()
          .child(v_virtual_list(this.id, this.rows.length, LINE_H, i => String(i), range =>
            this.rows.slice(range.start, range.end).map((row, offset) => h_flex().h(LINE_H).w_full().items_center().whitespace_nowrap()
              .child(div().w(this.gutter).pr(12).flex_none().text_right().text_color(t.dim).child(String(range.start + offset + 1)))
              .children(row.map(piece => div().flex_none().whitespace_nowrap().text_color(this.syntax[piece.kind] ?? t.foreground).child(piece.text)))))
            .size_full())))
      .child(Scrollbar.vertical(this.id).viewport_from_layout().absolute().inset_0());
  }
}
