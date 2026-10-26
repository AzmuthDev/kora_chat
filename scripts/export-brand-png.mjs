// Gera as versões PNG da marca Kora (redes sociais, logos transparentes e ícones) a partir dos SVGs em brand/.
// Usa o Chrome (ou Edge) já instalado, em modo headless. Uso: node scripts/export-brand-png.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "brand");
const out = path.join(brand, "png");

const browser = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));
if (!browser) throw new Error("Chrome ou Edge não encontrado.");

const C = { cobalt: "#2848C8", ink: "#1B2430", paper: "#EEF1F4", white: "#FFFFFF" };

/** SVG da marca com a cor do traço trocada (o ponto continua âmbar). */
const svg = (file, stroke) =>
  readFileSync(path.join(brand, file), "utf8").replace(/stroke="#1B2430"/g, `stroke="${stroke}"`).replace(/<!--[\s\S]*?-->/g, "");
const wordmark = (stroke) => svg("kora-wordmark.svg", stroke);
const symbol = (stroke) => svg("kora-simbolo.svg", stroke);
const appIcon = () => readFileSync(path.join(brand, "kora-icone-app.svg"), "utf8");

/**
 * Cada peça: tamanho final, fundo (null = transparente) e o SVG com a largura que ele ocupa.
 * `offsetX` desloca o centro horizontal (fração da largura), para capas com foto de perfil por cima.
 */
const assets = [
  // Foto de perfil: as redes cortam em círculo, então o K ocupa só o miolo.
  { name: "perfil-1080", w: 1080, h: 1080, bg: C.cobalt, art: symbol(C.white), width: 0.5 },
  // Posts e stories
  { name: "post-claro-1080", w: 1080, h: 1080, bg: C.paper, art: wordmark(C.ink), width: 0.62 },
  { name: "post-escuro-1080", w: 1080, h: 1080, bg: C.ink, art: wordmark(C.white), width: 0.62 },
  { name: "story-1080x1920", w: 1080, h: 1920, bg: C.cobalt, art: wordmark(C.white), width: 0.6 },
  // Prévia de link (Open Graph: WhatsApp, LinkedIn, sites)
  { name: "previa-link-1200x630", w: 1200, h: 630, bg: C.paper, art: wordmark(C.ink), width: 0.46 },
  // Capas: área segura no centro (o celular corta as laterais); no LinkedIn a foto cobre o canto esquerdo.
  { name: "capa-linkedin-1584x396", w: 1584, h: 396, bg: C.cobalt, art: wordmark(C.white), width: 0.24, offsetX: 0.12 },
  { name: "capa-facebook-1640x624", w: 1640, h: 624, bg: C.cobalt, art: wordmark(C.white), width: 0.28 },
  { name: "capa-youtube-2560x1440", w: 2560, h: 1440, bg: C.cobalt, art: wordmark(C.white), width: 0.3 },
  // Logos com fundo transparente
  { name: "logo-escuro-transparente", w: 2000, h: 900, bg: null, art: wordmark(C.ink), width: 0.84 },
  { name: "logo-branco-transparente", w: 2000, h: 900, bg: null, art: wordmark(C.white), width: 0.84 },
  { name: "simbolo-escuro-1024", w: 1024, h: 1024, bg: null, art: symbol(C.ink), width: 0.84 },
  { name: "simbolo-branco-1024", w: 1024, h: 1024, bg: null, art: symbol(C.white), width: 0.84 },
  // Ícones (cantos arredondados transparentes; o do iPhone é quadrado cheio porque o iOS arredonda sozinho)
  { name: "icone-app-1024", w: 1024, h: 1024, bg: null, art: appIcon(), width: 1 },
  { name: "icone-512", w: 512, h: 512, bg: null, art: appIcon(), width: 1 },
  { name: "apple-touch-icon-180", w: 180, h: 180, bg: C.cobalt, art: symbol(C.white), width: 0.75 },
  { name: "favicon-48", w: 48, h: 48, bg: null, art: appIcon(), width: 1 },
  { name: "favicon-32", w: 32, h: 32, bg: null, art: appIcon(), width: 1 },
  { name: "favicon-16", w: 16, h: 16, bg: null, art: appIcon(), width: 1 },
];

mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(path.join(os.tmpdir(), "kora-png-"));
try {
  for (const a of assets) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:${a.w}px;height:${a.h}px;overflow:hidden;background:${a.bg ?? "transparent"}}
      /* Centraliza pelo tamanho da imagem, não pela janela: o Chrome não abre janelas com menos de ~500 px. */
      body{position:relative}
      .art{position:absolute;top:50%;left:${50 + (a.offsetX ?? 0) * 100}%;transform:translate(-50%,-50%);width:${a.width * a.w}px}
      .art svg{display:block;width:100%;height:auto}
    </style></head><body><div class="art">${a.art}</div></body></html>`;
    const page = path.join(tmp, `${a.name}.html`);
    writeFileSync(page, html);
    const target = path.join(out, `${a.name}.png`);
    execFileSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        `--window-size=${a.w},${a.h}`,
        `--screenshot=${target}`,
        pathToFileURL(page).href,
      ],
      { stdio: "ignore" },
    );
    console.log(`${a.name}.png  ${a.w}x${a.h}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${assets.length} arquivos em ${path.relative(root, out)}`);
