# Google 登入（存最愛）設定步驟

> 這份由 Claude 產生（2026-10-27）。照著做完，網站右上角會出現「G 登入」：
> 用 Google 帳號登入後，最愛存在帳號裡，換手機、換電腦都看得到；沒登入的人照常使用，按「加入最愛」時才會請他登入。
> 沒設定前，網站照舊運作：沒有登入按鈕，最愛存在各自裝置的瀏覽器裡。
>
> **2026-10-27 已設定完成**：用的是 Firebase 專案 `climbing-map-25afd`（有開 Google Analytics）；`climbing-map-4041c` 是多建的，沒用到，可以刪。
> 看流量：Firebase 主控台 → climbing-map-25afd → Analytics，或 <https://analytics.google.com/>。
> Google Analytics 已建立自訂維度「館名」（`gym_name`）、「搜尋字」（`search_term`），從 2026-10-27 起開始統計。
> 看哪間館最多人開：報表 → 互動 → 事件 → 點 `open_gym` → 看「館名」；搜尋字：同樣點 `search` → 看「搜尋字」。
> 也可以在「探索」建一張表，維度選「館名」或「搜尋字」，指標選「事件計數」。

用的是 Google 的 **Firebase**（免費方案就夠，不用綁信用卡）：
- **Authentication**：Google 帳號登入
- **Firestore**：存每個人的最愛，一個人一份（`users/你的帳號代號`），安全規則設成只有本人能讀寫

---

## 步驟 1：建立 Firebase 專案（約 3 分鐘）

1. 用你的 Google 帳號打開 <https://console.firebase.google.com/>，按 **建立專案**（Create a project）。
2. 專案名稱填 `climbing-map`（後面系統會自動加一串字，沒關係）→ 繼續。
3. 「Google Analytics」可以關掉 → **建立專案**。

## 步驟 2：開啟 Google 登入（約 2 分鐘）

1. 左邊選單 **建構（Build）→ Authentication** → **開始使用**。
2. **登入方式（Sign-in method）** 分頁 → 選 **Google** → 打開「啟用」→ 選你的信箱當「專案支援電子郵件」→ **儲存**。
3. 同一頁上方切到 **設定（Settings）→ 授權網域（Authorized domains）** → **新增網域**，填：

   ```
   tim062480-create.github.io
   ```

   （`localhost` 預設就在清單裡，本機預覽也能登入。）

## 步驟 3：建立 Firestore 資料庫、貼上安全規則（約 3 分鐘）

1. 左邊選單 **建構 → Firestore Database** → **建立資料庫**。
2. 位置選 **asia-east1（台灣）**；模式選 **以正式版模式啟動（production mode）** → 建立。
3. 上方切到 **規則（Rules）** 分頁，把裡面的內容**全部換成**下面這段 → **發布（Publish）**：

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 每個人只有一份最愛：users/{登入帳號的代號}，只有本人能讀、能寫
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.uid == uid
        && request.resource.data.keys().hasOnly(['favorites', 'updatedAt'])
        && request.resource.data.favorites is list
        && request.resource.data.favorites.size() <= 200;
    }
    // 其他資料一律不開放
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## 步驟 4：拿網頁要用的設定，傳給 Claude（約 2 分鐘）

1. 左上角 **專案總覽（Project Overview）** 旁的齒輪 → **專案設定**。
2. 往下到「你的應用程式」→ 按 **`</>`（網頁）** 圖示 → 應用程式暱稱填 `climbing-map` → **註冊應用程式**（不用勾 Firebase Hosting）。
3. 畫面會出現一段 `const firebaseConfig = { ... }`，把整段複製傳給 Claude。

   這段設定（apiKey、authDomain、projectId、appId…）**本來就是公開的**，放在網頁裡任何人都看得到，這是 Firebase 的正常用法；資料安全靠的是步驟 3 的規則。

Claude 會把它填進 `web/config.js` 的 `firebase`，push 之後網站就有登入功能。

---

## 之後要注意

- **最愛會不會被別人看到**：不會。規則限制只有登入的本人能讀寫自己的那一份；別人只能看到網站本身。
- **第一次登入**：這台裝置以前存的最愛（還沒有登入功能時存的）會自動併進帳號。
- **免費額度**：Firestore 免費方案每天 5 萬次讀取、2 萬次寫入；一個人開網頁讀 1 次、按一次最愛寫 1 次，個人和朋友使用遠遠用不完。
- **想看誰登入過**：Firebase 主控台 → Authentication → 使用者。
- **想停用登入**：把 `web/config.js` 的 `firebase` 清空，網站就回到「最愛存在各自裝置」的方式。
