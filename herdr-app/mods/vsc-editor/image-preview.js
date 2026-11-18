import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome } from "herdr";

export const isImage = path => /\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(path);
export class ImagePreview {
  constructor(file) { this.file = file; this.zoom = null; }
  async load() {
    const result = await exec("python3", ["-B", `${appHome()}/mods/vsc-editor/stage-image.py`, JSON.stringify({
      path: this.file.path, on: this.file.on ?? null, cache: `${appHome()}/data/vsc-editor/images`,
    })], { timeout: 600000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Image staging failed (${result.code})`);
    const info = JSON.parse(result.stdout), prefix = "data/vsc-editor/images/";
    if (typeof info.path !== "string" || !info.path.startsWith(prefix) || info.path.slice(prefix.length).includes("/")
      || !Number.isFinite(info.width) || info.width <= 0 || !Number.isFinite(info.height) || info.height <= 0
      || !Number.isSafeInteger(info.size) || info.size < 0) throw new Error("Image helper returned invalid preview metadata");
    this.info = info;
  }
  scale() {
    if (this.zoom !== null) return this.zoom;
    return Math.min(1, Math.max(1, (this.size?.width ?? 800) - 48) / this.info.width,
      Math.max(1, (this.size?.height ?? 600) - 48) / this.info.height);
  }
  button(id, label, t, action) {
    return div().id(id).h(24).px(8).flex().items_center().cursor_pointer().rounded(3)
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { action(); cx.notify(); }).child(label);
  }
  render(t) {
    if (!this.info) return div().size_full().p(16).text_color(t.dim).child("Loading image…");
    const scale = this.scale(), info = this.info;
    const w = Math.max(1, Math.round(info.width * scale)), h = Math.max(1, Math.round(info.height * scale));
    return v_flex().id("image-preview").size_full().min_h(0).bg(t.canvas)
      .child(h_flex().h(32).flex_none().px(8).gap(2).items_center().bg(t.background).border_b(1).border_color(t.border).text_size(12)
        .child(this.button("image-out", "−", t, () => { this.zoom = Math.max(0.01, scale / 1.25); }))
        .child(div().w(48).text_center().text_color(t.muted).child(`${Math.round(scale * 100)}%`))
        .child(this.button("image-in", "+", t, () => { this.zoom = Math.min(8, scale * 1.25); }))
        .child(this.button("image-fit", "Fit", t, () => { this.zoom = null; }))
        .child(this.button("image-actual", "1:1", t, () => { this.zoom = 1; }))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(`${info.width} × ${info.height} · ${Math.ceil(info.size / 1024)} KB`)))
      .child(div().id("image-scroll").flex_1().min_h(0).overflow_scrollbar()
        .on_size_change((size, cx) => {
          if (size.width !== this.size?.width || size.height !== this.size?.height) { this.size = size; cx.notify(); }
        })
        .on_pinch((e, cx) => { this.zoom = Math.max(0.01, Math.min(8, this.scale() * (1 + e.delta))); cx.stop_propagation(); cx.notify(); })
        .child(div().w(Math.max(w + 48, this.size?.width ?? 0)).h(Math.max(h + 48, this.size?.height ?? 0))
          .flex().items_center().justify_center().child(image(info.path).w(w).h(h).flex_none())));
  }
}
