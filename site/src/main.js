import './style.css';
import { engineFor, labelFor, PAIRS } from './engine.js';

const VERSION = '0.4.0';
const REPO = 'https://github.com/barmoshe/kbfix';

const STRIP = [
  ['בםצצןא שמג פודי אם צשןמ', 'commit and push to main'],
  ['ksudnt', 'לדוגמא'],
  ['ghbdtn', 'привет'],
  ['ma;ana', 'mañana'],
];

// Each example says which pair it belongs to, because that is the whole point:
// the same string reads differently depending on the two languages you chose.
const EXAMPLES = {
  'en-he': [
    ['בםצצןא שמג פודי אם צשןמ', 'English typed on the Hebrew layout'],
    ['ksudnt', 'Hebrew typed on the English layout'],
    ["ךקא'ד גם ןא", 'punctuation shifts too'],
    ['אני צריך לבדוק את הקובץ הזה', 'real Hebrew, left alone'],
    ['can you check the hook please', 'real English, left alone'],
  ],
  'en-ru': [
    ['ghbdtn', 'Russian typed on the English layout'],
    ['Ghbdtn', 'the capital survives here'],
    ['руддщ', 'English typed on the Russian layout'],
    ['привет как дела', 'real Russian, left alone'],
  ],
  'en-es': [
    ['ma;ana', 'the ñ key is where ; sits'],
    ['el ni;o pequeno', 'ñ comes back, the accent cannot'],
    ['hola que tal amigo', 'correct Spanish, nothing to do'],
    ['const x = 1;', 'code is not a lost ñ'],
  ],
  'he-ru': [
    ['עינגאמ', 'Russian typed on the Hebrew layout'],
    ['флгщ', 'Hebrew typed on the Russian layout'],
    ['שלום חברים', 'real Hebrew, left alone'],
    ['привет как дела', 'real Russian, left alone'],
  ],
  'es-he': [
    ['יםךש', 'Spanish typed on the Hebrew layout'],
    ['נוקמםד גןשד', 'buenos dias, the same way'],
    ['hola que tal', 'real Spanish, left alone'],
  ],
  'es-ru': [
    ['игутщы вшфы', 'Spanish typed on the Russian layout'],
    ['рщдф фьшпщ', 'hola amigo, the same way'],
    ['спасибо большое', 'real Russian, left alone'],
  ],
};

const state = { pair: ['en', 'he'], text: 'ksudnt' };

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function shell() {
  return `
  <div class="wrap">
    <header class="hero">
      <div class="brand">kbfix<span class="dot">.</span> <span class="version">v${VERSION}</span></div>
      <h1>Text typed on the wrong keyboard, read back.</h1>
      <p class="lede">
        Nothing was lost when you typed that. The keystrokes landed; only the table
        that rendered them was wrong. kbfix is a Claude Code plugin that notices and
        tells Claude how your prompt actually reads.
      </p>
      <div class="strip">
        ${STRIP.map(([a, b]) => `
          <div class="strip-row">
            <span class="from">${esc(a)}</span>
            <span class="arrow">&rarr;</span>
            <span class="to">${esc(b)}</span>
          </div>`).join('')}
      </div>
    </header>

    <section id="try">
      <h2>Try it</h2>
      <p class="sub">
        This runs the plugin's real engine, the same code the hook uses, compiled
        into the page. Pick a pair and type: kbfix works on two languages at a
        time, so the same string reads differently depending on which two.
      </p>
      <div class="pairbar" id="pairbar"></div>
      <div class="play">
        <div class="play-head"><span id="playhead"></span><span>live</span></div>
        <textarea id="input" spellcheck="false" autocapitalize="off" autocorrect="off"></textarea>
        <div class="verdict" id="verdict"></div>
      </div>
      <div class="examples" id="examples"></div>
    </section>

    <section>
      <h2>How it decides</h2>
      <p class="sub">
        Transpose the text into the other language, then ask whether the result reads
        more like real prose than what you actually typed. Say so only when the gap is wide.
      </p>
      <div class="cols">
        <div class="col">
          <h3>word list</h3>
          <p>The most frequent words of each language score outright. Fast, and certain when it hits.</p>
        </div>
        <div class="col">
          <h3>bigrams</h3>
          <p>Everything else is judged on whether its spelling is plausible. A word list cannot recognise <span class="mono">לדוגמא</span>, so without this <span class="mono">ksudnt</span> is undetectable.</p>
        </div>
        <div class="col">
          <h3>structure</h3>
          <p>One near-decisive tell per language. In Hebrew a final form away from the end of a word, which real words never do and layout junk does constantly.</p>
        </div>
      </div>
      <div class="note" style="margin-top: 26px">
        <p><b>It never rewrites your prompt.</b> It adds a note saying how it read the text and leaves what you typed exactly as you typed it. A wrong guess has to stay visible and correctable, so the hook uses <span class="mono">additionalContext</span> and never <span class="mono">updatedPrompt</span>. A test asserts that word never appears in its output.</p>
      </div>
    </section>

    <section>
      <h2>Accuracy</h2>
      <p class="sub">
        Accuracy belongs to the pair, not to the tool, so it is reported that way.
        4,000 lines per sweep, and zero false positives in all six pairs.
      </p>
      <table>
        <thead><tr><th>pair</th><th>caught</th><th>exact decode</th><th>false positives</th></tr></thead>
        <tbody>
          <tr class="best"><td class="pair">en &harr; he</td><td class="num">99.9% / 99.7%</td><td class="num">100%</td><td class="num">0</td></tr>
          <tr class="best"><td class="pair">en &harr; ru</td><td class="num">99.9% / 99.9%</td><td class="num">100%</td><td class="num">0</td></tr>
          <tr class="best"><td class="pair">he &harr; ru</td><td class="num">99.7% / 99.7%</td><td class="num">100%</td><td class="num">0</td></tr>
          <tr><td class="pair">en &harr; es</td><td class="num">0% / 5.5%</td><td class="num">100%</td><td class="num">0</td></tr>
          <tr><td class="pair">es &harr; he</td><td class="num">48% / 82%</td><td class="num">partial</td><td class="num">0</td></tr>
          <tr><td class="pair">es &harr; ru</td><td class="num">49% / 96%</td><td class="num">partial</td><td class="num">0</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>Why Spanish barely works</h2>
      <p class="sub">This is a property of the alphabets, not something a better model would fix.</p>
      <div class="note">
        <p>Hebrew and Russian write <b>different scripts</b> from English. Every letter moves, so a wrong-layout mistake turns a sentence into visible nonsense, and every one of those characters is evidence.</p>
        <p>Spanish writes the <b>same script</b> and puts every letter <span class="mono">a</span> to <span class="mono">z</span> in the same place. Compare the two key tables and <b>zero letters differ</b>. A Spanish speaker on a US keyboard does not get nonsense, they get Spanish with one wrong character: <span class="mono">ma;ana</span>. So the <span class="mono">en-es</span> pair buys you <span class="mono">ñ</span> and nothing else. Accented vowels are dead-key sequences and stay unrecoverable.</p>
      </div>
    </section>

    <section>
      <h2>Install</h2>
      <pre><span class="c"># in Claude Code</span>
/plugin marketplace add barmoshe/kbfix
/plugin install kbfix@kbfix</pre>
      <p class="sub" style="margin-bottom:14px">Needs <span class="mono">node</span> on your PATH. The default pair is English and Hebrew. To change it, drop a <span class="mono">.kbfix.json</span> in your project or home directory:</p>
      <pre>{ <span class="c">"pair"</span>: [<span class="c">"en"</span>, <span class="c">"ru"</span>] }</pre>
      <ul class="plain">
        <li><b>Two languages at a time.</b> It is not a language detector and will not guess among several. With <span class="mono">en-he</span> set, Russian gibberish is left alone on purpose.</li>
        <li><b>Adding a language is adding a folder.</b> A key table dumped from your own machine with <span class="mono">UCKeyTranslate</span>, a frequency corpus, and a generated model.</li>
        <li><b>The shipped tables are macOS ABC, Hebrew, Russian and Spanish.</b> They are wrong for Hebrew&nbsp;-&nbsp;QWERTY, Hebrew&nbsp;-&nbsp;PC and the phonetic Russian&nbsp;-&nbsp;QWERTY. Regenerate your own with the bundled dumper.</li>
      </ul>
    </section>

    <footer>
      <span>MIT. Built by Bar Moshe.</span>
      <span><a href="${REPO}">github.com/barmoshe/kbfix</a></span>
    </footer>
  </div>`;
}

function pairId(p) { return p.join('-'); }

async function renderPairbar() {
  const bar = document.getElementById('pairbar');
  const labels = {};
  for (const [a, b] of PAIRS) {
    labels[a] = labels[a] || (await labelFor(a));
    labels[b] = labels[b] || (await labelFor(b));
  }
  bar.innerHTML = PAIRS.map((p) => {
    const on = pairId(p) === pairId(state.pair);
    return `<button class="pairbtn" aria-pressed="${on}" data-pair="${pairId(p)}">${p[0]} &harr; ${p[1]}</button>`;
  }).join('');
  bar.querySelectorAll('.pairbtn').forEach((b) => {
    b.addEventListener('click', () => {
      state.pair = b.dataset.pair.split('-');
      renderPairbar();
      renderExamples();
      run();
    });
  });
  document.getElementById('playhead').textContent =
    `${labels[state.pair[0]]} <-> ${labels[state.pair[1]]}`;
}

function renderExamples() {
  const box = document.getElementById('examples');
  const list = EXAMPLES[pairId(state.pair)] || [];
  box.innerHTML = list
    .map(([t, why]) => `<button class="ex" data-t="${esc(t)}">${esc(t)} <i>${esc(why)}</i></button>`)
    .join('');
  box.querySelectorAll('.ex').forEach((b) => {
    b.addEventListener('click', () => {
      state.text = b.dataset.t;
      document.getElementById('input').value = state.text;
      run();
    });
  });
}

const D = { minTargetScore: 0.65, minMargin: 0.35, minCandidateGap: 0.15 };

async function run() {
  const out = document.getElementById('verdict');
  const text = state.text;
  if (!text.trim()) {
    out.innerHTML = `<span class="badge miss">nothing to read</span>
      <p class="reading none">Type something, or pick an example below.</p>`;
    return;
  }

  let engine;
  try {
    engine = await engineFor(state.pair);
  } catch (err) {
    out.innerHTML = `<span class="badge miss">error</span><p class="why">${esc(String(err.message || err))}</p>`;
    return;
  }

  const r = engine.analyze(text);
  const s = r.scores;

  const scores = s
    ? `<div class="scores">
        <span class="score ${s.target < D.minTargetScore ? 'fail' : ''}">reads like prose <b>${s.target}</b> <span style="opacity:.6">&ge; ${D.minTargetScore}</span></span>
        <span class="score ${s.margin < D.minMargin ? 'fail' : ''}">beats what you typed by <b>${s.margin}</b> <span style="opacity:.6">&ge; ${D.minMargin}</span></span>
        ${s.gap !== null && s.gap !== undefined
          ? `<span class="score ${s.gap < D.minCandidateGap ? 'fail' : ''}">beats the runner-up by <b>${s.gap}</b> <span style="opacity:.6">&ge; ${D.minCandidateGap}</span></span>`
          : ''}
      </div>`
    : '';

  if (r.confident) {
    out.innerHTML = `<span class="badge hit">reads as ${esc(r.direction)}</span>
      <p class="reading">${esc(r.decoded)}</p>
      <p class="why">Your prompt is left exactly as typed. Claude is told this is how it reads.</p>
      ${scores}`;
  } else {
    out.innerHTML = `<span class="badge miss">left alone</span>
      <p class="reading none">${esc(r.reason)}</p>
      ${r.candidates && r.candidates.length
        ? `<p class="why">Best it could do: <span class="mono">${esc(r.candidates[0].decoded)}</span></p>`
        : ''}
      ${scores}`;
  }
}

document.getElementById('app').innerHTML = shell();
const input = document.getElementById('input');
input.value = state.text;
input.addEventListener('input', () => { state.text = input.value; run(); });

await renderPairbar();
renderExamples();
run();
