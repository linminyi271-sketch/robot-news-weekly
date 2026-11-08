# 機器人產業新聞週報

每週整理國內外機器人產業新聞與「本週重點觀察」，團隊成員都能上傳新聞。

## 功能

- 新增刪除管理：可勾選多則新聞批次刪除，或依期別（日期區間與新聞則數）刪除整期新聞；刪除前會再次確認。

- 依期別瀏覽（上一期／下一期、所有期別清單），國內／國外分區
- 本週重點觀察
- 跨期全文搜尋（關鍵字標示）、依區域／來源／主題標籤篩選
- 上傳 Word 週報自動拆成一則則新聞、自動建議標籤、自動略過重複新聞
- 也可以貼上文字（含 AI 整理的內容），或單則新增
- 匯出 PDF（列印版面）與 CSV（Excel 可直接開啟）
- 深色模式、手機版
- 記錄每筆資料的上傳者（只存在後台試算表，網頁不顯示）

刪除新聞時，網站會以隱藏標記保留後台紀錄；如要啟用跨裝置共用刪除，請依 `SETUP.md` 部署最新的 `apps-script/Code.gs` 並設定 `config.js` 的 `API_URL`。

## 每週怎麼更新

1. 打開網站 → 右上角 **新增新聞**
2. 拖入 Word 週報 → 確認預覽（可修改區域、標題、標籤）
3. 填上傳者 → **發布**

Word 格式請照 `templates/週報標準範本.docx`，與現行週報相同。

## 文件

- **第一次部署**：看 [SETUP.md](SETUP.md)
- **請 AI 修改網站**：把 [AGENTS.md](AGENTS.md) 和要改的檔案一起交給 AI。它會知道每個檔案負責什麼，只改需要的部分

## 用 ChatGPT 修改網站

- **ChatGPT（一般對話）**：上傳 `AGENTS.md` 和要改的檔案（例如改顏色就給 `assets/style.css`），說明需求；拿回修改後的檔案，再到 GitHub 上傳覆蓋。
- **ChatGPT Codex 或其他能連 GitHub 的 AI 工具**：直接連到這個 repository，它會自動讀取 `AGENTS.md`。
- **Claude Code**：同上，`CLAUDE.md` 會指向 `AGENTS.md`。

## 檔案結構

```
index.html              頁面骨架
config.js               網站設定（名稱、資料庫網址、標籤）
assets/style.css        樣式
assets/app.js           互動功能
assets/parser.js        Word／文字解析
assets/store.js         資料讀寫
assets/vendor/          第三方套件（JSZip）
apps-script/Code.gs     Google 試算表後端
data/seed.js            預覽模式範例資料
templates/              Word 範本與第一期範例
```
