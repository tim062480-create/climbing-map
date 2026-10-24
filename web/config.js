// 網頁設定。留言區用 giscus（留言存在這個 repo 的 GitHub Discussions，留言要登入 GitHub）。
// 開啟方法見 README.md 的「開啟留言區」；四個值都填好後留言區才會出現。
window.CLIMBING_CONFIG = {
  giscus: {
    repo: "tim062480-create/climbing-map",
    repoId: "",       // 例如 "R_kgDO..."
    category: "抱石館留言",
    categoryId: "",   // 例如 "DIC_kwDO..."
  },
  // 大眾運輸路線：TDX 中繼（relay/tdx-worker.js）部署後的網址，例如 "https://climbing-map-tdx.xxx.workers.dev"。
  // 空著時大眾運輸只顯示粗估時間和 Google 地圖按鈕。設定步驟見 docs/TDX大眾運輸設定步驟.md
  transitRelay: "",
};
