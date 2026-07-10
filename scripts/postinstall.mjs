// Printed once after `npm install` / `npm i -g folderpreview` / `npm link`. Pure cosmetics —
// it must NEVER break an install, so all output is wrapped and the process always exits 0.
// Zero dependencies; colour is emitted only to a real TTY (npm log capture stays clean).
const tty = !!process.stdout.isTTY;
const on = c => (tty ? c : '');
const R = on('\x1b[0m');
const O = on('\x1b[38;2;255;176;102m');   // light orange — the foldview accent
const Y = on('\x1b[38;2;255;214;153m');   // pale orange highlight
const D = on('\x1b[2m');
const B = on('\x1b[1m');
const G = on('\x1b[38;2;120;205;170m');   // exhaust green

const art = `
${O}              /\\${R}
${O}             /  \\${R}
${O}            /    \\${R}
${O}           / ${Y}◍${O}  \\${R}      ${B}${O}F O L D V I E W${R}
${O}          |      |${R}     ${D}your projects + AI coding${R}
${O}          |      |${R}     ${D}tools, ready in one terminal${R}
${O}         /|      |\\${R}
${O}        / |      | \\${R}
${O}       /__|______|__\\${R}
${G}          \\  /\\  /${R}
${G}           \\/  \\/${R}
${G}            ▲    ▲${R}
`;

try {
  // Skip the noise for nested/CI dependency installs; show it for a direct global/dev install.
  const globalish = process.env.npm_config_global === 'true' || !process.env.npm_config_save;
  process.stdout.write(art);
  process.stdout.write(`  ${B}${O}🚀 foldview installed.${R}\n`);
  process.stdout.write(`  ${D}run${R} ${B}foldview${R} ${D}(or${R} ${B}pm${R}${D}) in any folder — ↵ opens a project's localhost.${R}\n\n`);
  void globalish;
} catch { /* never fail an install over a banner */ }
process.exit(0);
