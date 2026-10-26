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
  // Google 登入（Firebase）：填好後網頁右上角出現「登入」，最愛存在登入的帳號裡（換手機也在）；
  // 沒登入的人照常使用，按「加入最愛」時才請他登入。這幾個值是公開的（本來就會出現在網頁裡），
  // 資料安全靠 Firestore 的安全規則。空著時沒有登入功能，最愛存在各自裝置的瀏覽器裡。
  // 設定步驟見 docs/Google登入設定步驟.md
  // measurementId 是 Google Analytics 的流量統計（只算匿名的瀏覽人數）。
  firebase: {
    apiKey: "AIzaSyA0sicWgoDXYZ44iUhbnQHSU5foDAY94gw",
    authDomain: "climbing-map-25afd.firebaseapp.com",
    projectId: "climbing-map-25afd",
    appId: "1:305130952506:web:8da3d35f819ea160e0e203",
    measurementId: "G-7Q484ZJYFY",
  },
};
