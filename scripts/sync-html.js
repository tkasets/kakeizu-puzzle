// 同じフォルダの Web 版 HTML（index.html）を読み込み、アプリに埋め込む
// htmlSource.js を再生成する。Web 版を更新したら `npm run sync-html` を実行する。
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../index.html');
const OUT = path.resolve(__dirname, '../htmlSource.js');

const raw = fs.readFileSync(SRC, 'utf8');
// AdSense はアプリ内（WebView）での使用が規約違反なので、Web 版だけに置いた
// スクリプトをマーカーごと取り除く。アプリ側の広告は AdMob が担当する。
const html = raw.replace(
  /[ \t]*<!-- adsense:web-only:start -->[\s\S]*?<!-- adsense:web-only:end -->\r?\n?/g,
  ''
);
// JSON.stringify にすることで、HTML 内のバッククォートや ${} を安全にエスケープする
fs.writeFileSync(
  OUT,
  '// AUTO-GENERATED from kakeizu-puzzle/index.html. Regenerate with: npm run sync-html\n' +
    'export default ' +
    JSON.stringify(html) +
    ';\n'
);
console.log(`htmlSource.js を更新しました (html length = ${html.length})`);
