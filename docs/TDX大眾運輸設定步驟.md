# 大眾運輸路線（TDX）設定步驟

> 這份由 Claude 產生（2026-10-24）。照著做完，網頁上館的「交通 → 🚇 大眾運輸」就會顯示公車、捷運要怎麼搭、幾點上車、幾點到。
> 沒設定時，大眾運輸只顯示粗估時間和 Google 地圖按鈕，網頁其他功能不受影響。

## 整體架構

```
手機上的網頁 ──► Cloudflare Worker（中繼，金鑰放這裡）──► 交通部 TDX 旅運規劃 API
```

TDX 要用 **Client Id + Client Secret** 換 token 才能呼叫。這兩個值不能放在網頁裡（任何人打開網頁原始碼都看得到），所以要一個「中繼」幫忙保管。中繼用 Cloudflare Workers，免費方案每天 10 萬次，完全夠用，**不用裝任何軟體，全部在網頁上操作**。

中繼的程式已經寫好在 `relay/tdx-worker.js`，它只接受你的網站（`tim062480-create.github.io`）和本機預覽呼叫，同一段路 5 分鐘內重複查會直接用快取，避免用掉 TDX 額度。

---

## 步驟 1：申請 TDX 會員和 API 金鑰（約 10 分鐘）

1. 打開 <https://tdx.transportdata.tw/register> 註冊會員（免費，選「一般會員」即可），到信箱點驗證信。
2. 登入後到 **會員中心 → 資料服務 → API 金鑰**（<https://tdx.transportdata.tw/user/dataservice/key>），會看到一組預設金鑰：
   - **Client Id**（像 `xxxx-xxxxxxxx-xxxx-xxxx`）
   - **Client Secret**（一長串英數）
3. 確認你的帳號可以用「旅運規劃」：打開 [公共運輸旅運規劃 API 說明](https://tdx.transportdata.tw/api-service/swagger/maas/4513f9d6-caae-4cf7-a50c-e7887bec804e)，按右上 **Authorize**，填 Client Id／Client Secret，找到 `/routing` 按 **Try it out** 隨便試一筆（起點、終點填「緯度,經度」，例如 `25.0478,121.5170` 和 `25.0026,121.5133`）。
   - 有回傳路線 → 可以用，進行步驟 2。
   - 回 401／403 → 這個服務可能要另外申請或訂閱，畫面上通常會寫怎麼申請；看不懂就截圖給 Claude。

> ⚠️ **Client Secret 不要貼到聊天、不要寫進 repo**。它只要貼在步驟 2 的 Cloudflare 加密變數裡。

## 步驟 2：建立 Cloudflare Worker（約 10 分鐘）

1. 到 <https://dash.cloudflare.com/sign-up> 註冊 Cloudflare（免費），驗證信箱。
2. 左邊選單 **Compute (Workers) → Workers & Pages → Create → Create Worker**（或「Start with Hello World」）。
   - 名稱填 `climbing-map-tdx` → **Deploy**。
3. 部署完按 **Edit code**，把編輯器裡的程式**全部刪掉**，換成 repo 裡 [`relay/tdx-worker.js`](../relay/tdx-worker.js) 的全部內容 → 右上 **Deploy**。
4. 回到這個 Worker 的頁面 → **Settings → Variables and Secrets → Add**，新增兩個，類型都選 **Secret**：

   | Variable name | Value |
   |---|---|
   | `TDX_CLIENT_ID` | 步驟 1 的 Client Id |
   | `TDX_CLIENT_SECRET` | 步驟 1 的 Client Secret |

   按 **Deploy**（或 Save and deploy）。
5. 記下 Worker 的網址，在 Worker 頁面上方，長得像 `https://climbing-map-tdx.你的帳號.workers.dev`。

## 步驟 3：把網址告訴 Claude

把步驟 2 的 **Worker 網址** 傳給 Claude（這個網址不是機密，可以公開），Claude 會：

1. 實際呼叫一次，確認 TDX 回傳的格式和網頁解析的一致（目前的解析是照文件寫的，還沒用真的資料測過），需要的話調整程式。
2. 填進 `web/config.js` 的 `transitRelay`，commit、push。

想自己填也可以：打開 `web/config.js`，把 `transitRelay: ""` 改成 `transitRelay: "https://climbing-map-tdx.你的帳號.workers.dev"`。

---

## 之後要注意

- **改了 `relay/tdx-worker.js`**：要再貼一次到 Cloudflare 的編輯器、按 Deploy，GitHub 上的檔案不會自動同步過去。
- **換網址或加本機預覽的 port**：改 `relay/tdx-worker.js` 最上面的 `ALLOWED_ORIGINS`。
- **金鑰外洩或想換**：在 TDX 會員中心重新產生金鑰，再到 Cloudflare 的 Variables and Secrets 改值。
- **TDX 額度**：會員的呼叫次數有上限（看 TDX「訂閱收費」頁），中繼有 5 分鐘快取，而且只有使用者點開「大眾運輸」分頁才會查，一般使用不會超過。
