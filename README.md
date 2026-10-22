# math-notes-previewer

Markdown、KaTeX、TikZ で書いた数学の原稿を HTML に変換する CLI とブラウザプレビューワー。

原稿は原稿ごとのリポジトリで管理し、このパッケージを依存として読み込んで GitHub Pages に公開する。

## 原稿リポジトリの構成

CLI は実行したディレクトリをリポジトリのルートとして扱う。

- `manuscripts/index.md`：公開サイトのトップページになる原稿。
- `manuscripts/*.md`：`/<ファイル名>/` に公開する原稿。
- `manuscripts/<名前>/index.md`：`/<名前>/` に公開する原稿。
- `manuscripts/contents/`：`@import` で読み込む章。単独では公開しない。
- `site/`：`build` が生成する公開用 HTML。コミットしない。
- `build/preview-site/`：`preview` が生成するローカルプレビュー用 HTML。

`manuscripts/index.md` がない場合は、公開する原稿の一覧をトップページとして生成する。

## 導入

原稿リポジトリの `package.json` に、タグを指定して依存を追加する。

```json
{
  "private": true,
  "scripts": {
    "build": "math-notes build",
    "preview": "math-notes preview",
    "check": "math-notes check"
  },
  "dependencies": {
    "math-notes-previewer": "github:skrtk98/math-notes-previewer#v1.0.0"
  }
}
```

TikZ の変換には `latex` と `dvisvgm` を使う。
Ubuntu では次のコマンドで導入できる。

```bash
sudo apt-get install -y dvisvgm texlive-latex-extra texlive-pictures
```

## コマンド

- `npm run preview`：`http://localhost:4173/` でプレビューを開く。原稿を保存すると、表示中のページだけを再生成して再読み込みする。ポートは `PORT` 環境変数で変更できる。
- `npm run check`：公開対象の原稿を変換し、TikZ、数式、`@import` の処理に失敗した場合に終了コード 1 を返す。
- `npm run build`：公開用 HTML を `site/` に生成する。

`@import` は変換時に再帰的に展開する。
`latex` の属性付きコードフェンス（`cmd=true` を含む）内の TikZ は SVG に変換して埋め込む。
目次は見出しから自動生成する。
レイアウトは Markdown Preview Enhanced の HTML export 用実装に合わせている。

## GitHub Pages への公開

原稿リポジトリに次の workflow を置き、**Settings → Pages → Build and deployment** で **GitHub Actions** を選択する。

```yaml
name: Deploy GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    uses: skrtk98/math-notes-previewer/.github/workflows/deploy-pages.yml@v1.0.0
```

## 更新の配布

変更を `main` に push したら、新しいタグを付ける。
各原稿リポジトリは `package.json` と workflow のタグを更新し、`npm install` で `package-lock.json` を更新する。

## ライセンス

移植したレイアウト規則の出典とライセンスは `THIRD_PARTY_LICENSES.md` に記す。
