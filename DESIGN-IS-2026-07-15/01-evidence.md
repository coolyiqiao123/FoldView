# Evidence

## Structural evidence

- The static DOM exposes 31 interactive elements: 25 anchors, 2 native buttons, and 4 custom copy buttons (`site/index.html:1038-1078`, `1142-1150`, `1247-1257`, `1350-1387`, `1398-1427`).
- The primary DOM reaches 11 descendant edges below `body`, with the deepest path inside the MacBook terminal mockup (`site/index.html:1082-1131`).
- Eight affordance groups are repeated across 24 occurrences. Major nav destinations appear three times; the same install command appears three times (`site/index.html:1038-1078`, `1142-1150`, `1247-1250`, `1375-1383`, `1398-1424`).
- Main contains 10 sections: MacBook showcase, hero, typing demo, sentence reveal, features, install, keys, scripting, about, and finale (`site/index.html:1085-1387`).
- The clear product `h1` and install action begin only after a 2,160px/200vh pinned MacBook sequence at the measured 1280×720 viewport (`site/index.html:791-805`, `1085-1155`; live browser measurement).
- A second word-reveal section uses another 180vh scroll track before features (`site/index.html:703-726`, `1175-1180`).
- Four dead or knowingly ineffective units remain: unused butterfly/meadow CSS, unused garden-child CSS, unused `.stat` selectors, and a WebGL module whose source comments say it cannot mount against the nested DOM (`site/index.html:157-164`, `251-274`, `489-491`, `883-903`, `1928-1999`).

## Visual evidence

- Referenced spacing values span 39 unique values from 0.5px to 120px, and referenced type sizes span 38 values from 3px to 62px. These are one-off values, not a compact scale (`site/index.html:28-994`; parsed CSS declarations).
- The file references 74 distinct hex colors across themes, terminal islands, SVGs, mockups, and inline styles (`site/index.html:28-172`, `997-1390`).
- Typography roles are coherent: Inter for body, Space Grotesk for display, and JetBrains Mono for terminal/code (`site/index.html:42-44`, `276-293`).
- The desktop opening is tonally coherent but devotes nearly the whole viewport to aurora atmosphere and a hardware mockup; the primary install action is not visible (`site/index.html:791-805`, `1085-1153`; 1280×720 live browser and 1440×1000 render).
- At 500×757, the mobile nav collapses and later grids stack, but the two-pane terminal becomes a visual texture rather than readable product evidence, and the sticky scene still consumes the opening viewport (`site/index.html:354-358`, `550-551`, `905-965`; responsive renders).
- Simultaneous attention effects include mesh drift, aurora motion, custom cursor/grid lighting, scroll reveals, auto-cycling terminal selection, typing loops, and the loader (`site/index.html:184-274`, `694-786`, `1471-1751`).
- States present: loading, copy success, focus, light/dark theme, mobile menu, reduced motion. States missing or rough: empty, error, disabled, copy-failure feedback, and screen-reader success announcement (`site/index.html:978-1011`, `1375-1382`, `1438-1469`, `1905-1923`).

## Copy and honesty evidence

- Supported facts include Node 18+, MIT, four installed command aliases, zero declared runtime dependencies, AI CLI discovery, 1–9 terminal windows, JSON output, atomic local config, and static-site serving (`package.json:6-21`, `LICENSE:1-20`, `test/ai-discovery.test.mjs:13-115`, `test/grid.test.mjs:22-107`, `test/cli-surface.test.mjs:30-49`, `test/config.test.mjs:12-49`).
- Unsupported or inflated absolutes include “every project,” “everything running,” “any project,” “100% local — no network,” “no waiting,” “10 seconds,” “instantly,” “real lines of code,” and “on every Mac” (`site/index.html:1088`, `1162`, `1177`, `1187`, `1200`, `1216`, `1227`, `1241`).
- The scanner is bounded by depth, result count, ignored directories, file count, file size, and supported extensions (`folder.mjs:340-405`, `687-715`, `820-935`).
- The no-network claim omits the explicit GitHub publish workflow and the website's Google Fonts/jsDelivr requests (`folder.mjs:1478-1596`; `site/index.html:24-26`, `1968-1974`).
- “Star on GitHub” only opens the repository, and the menu-bar companion is described both as “on the way” and already living in the user's menu bar (`site/index.html:1194`, `1362`, `1384-1386`; `folder.mjs:2185-2190`).
- Naming is fragmented across Foldview, `foldview`, `pm`, `folderpreview`, and `project-manager`; the alias relationship is not explained until late in the page (`site/index.html:1048`, `1142-1152`, `1245-1257`, `1410-1412`).
- No pricing, scarcity, subscription, account-capture, confirmshaming, or cancellation dark pattern exists. The percentage loader is faux progress and intentional friction (`site/index.html:997-1011`, `1728-1751`).

## Weight and friction evidence

- Local decoded payload is 264,129 bytes: 123,867-byte HTML plus a 140,262-byte JPEG. The HTML contains 57,508 bytes of inline CSS and 29,532 bytes of inline JS.
- Remote decoded payload is approximately 224,538 bytes: Google Fonts CSS and three fonts plus a 103,827-byte LiquidGlass module (`site/index.html:24-26`, `1968-1974`).
- Total initial decoded/parsed JS is 133,359 bytes. A cold default view made 7 requests and transferred 395,435 encoded bytes in localhost instrumentation.
- Browser `domInteractive` measured about 96ms, but the simulated loader delayed usable interaction to 1.85–2.29 seconds (mean 1.99 seconds) over five cold runs (`site/index.html:771-786`, `1728-1751`).
- Default dark desktop maintains eight idle animation instances after the loader: mesh, aurora, three port pulses, caret, selected-project cycle, and typing loop (`site/index.html:193-224`, `441-442`, `509-510`, `1645-1651`, `1717-1725`).
- Reduced motion is comprehensively honored and skips the loader and remote WebGL import (`site/index.html:980-994`, `1441`, `1645-1651`, `1716`, `1731-1733`, `1969-1973`).

## Accessibility evidence

- A visible global focus ring and keyboard handlers for custom copy controls exist (`site/index.html:978`, `1142`, `1247`, `1255`, `1375`, `1464-1468`).
- No skip link exists. The opening `h2` precedes the sole `h1`, other sections skip heading levels, and desktop nav is unlabeled (`site/index.html:1035-1088`, `1139`, `1158-1162`, `1413-1427`).
- Auto-hidden nav remains focusable while translated offscreen (`site/index.html:297-303`, `1858-1876`).
- Clickable terminal rows have no role, tabindex, or key handler and sit inside `role="img"`; auto-cycle pauses only for mouse hover (`site/index.html:1093`, `1598-1651`).
- Copy success changes visible text but is not announced through a live region or changed accessible name (`site/index.html:1142-1149`, `1443-1449`).
- Light-theme normal-text failures include `--faint` 3.59:1, `--brand-2` 4.37:1, `--cyan` 3.10:1, `--green` 3.94:1, and `--red` 4.36:1 on the base background. Dark-island faint text reaches only 4.40:1 on `#0A1120` (`site/index.html:53-80`, `316-652`).
- Declared landmarks total seven statically; no skip link, forced-colors treatment, or prefers-contrast treatment exists (`site/index.html:1035-1436`).

## Known gaps

- Production-host CDN latency, caching, and transfer compression were not measured.
- Exact 320/375/390px real-device Safari and Chrome rendering remains unverified; the independent renderer clamped to 500px.
- VoiceOver announcements, actual Tab traversal, 200% zoom/reflow, forced colors, and pixel contrast over translucent image-backed glass were not exercised.
- The founder biography and “sole developer” claim were not independently verified.

