# TÀI LIỆU HƯỚNG DẪN SỬ DỤNG ZCA-JS (ZALO API KHÔNG CHÍNH THỨC)

Tài liệu này cung cấp hướng dẫn chi tiết về cách cài đặt, cấu hình, đăng nhập và sử dụng thư viện `zca-js` để tự động hóa hoặc tích hợp chatbot cho tài khoản Zalo cá nhân.

> [!WARNING]
> **Khuyến cáo quan trọng:** `zca-js` là một thư viện API không chính thức hoạt động bằng cách giả lập hành vi trình duyệt tương tác với Zalo Web. Việc sử dụng thư viện này có rủi ro bị khóa hoặc cấm tài khoản Zalo vĩnh viễn. Hãy cân nhắc kỹ và chịu trách nhiệm trước khi sử dụng.

---

## 📌 MỤC LỤC

1. [Giới thiệu & Nguyên lý hoạt động](#1-giới-thiệu--nguyên-lý-hoạt-động)
2. [Cài đặt & Nâng cấp lên V2](#2-cài-đặt--nâng-cấp-lên-v2)
3. [Các phương thức đăng nhập](#3-các-phương-thức-đăng-nhập)
   - [Đăng nhập bằng Cookie & IMEI](#đăng-nhập-bằng-cookie--imei)
   - [Đăng nhập bằng mã QR (loginQR)](#đăng-nhập-bằng-mã-qr-loginqr)
   - [Đăng nhập nhiều tài khoản](#đăng-nhập-nhiều-tài-khoản)
   - [Cấu hình sử dụng Proxy](#cấu-hình-sử-dụng-proxy)
4. [Lắng nghe sự kiện Realtime (WebSocket Listener)](#4-lắng-nghe-sự-kiện-realtime-websocket-listener)
5. [Các hàm API gửi tin nhắn & Tương tác](#5-các-hàm-api-gửi-tin-nhắn--tương-tác)
   - [Gửi tin nhắn (Văn bản & Trích dẫn)](#gửi-tin-nhắn-văn-bản--trích-dẫn)
   - [Gửi hình ảnh & Sticker](#gửi-hình-ảnh--sticker)
   - [Gửi Video, File & Voice thoại](#gửi-video-file--voice-thoại)
   - [Thả cảm xúc & Thu hồi tin nhắn](#thả-cảm-xúc--thu-hồi-tin-nhắn)
6. [Quản lý hội thoại & Nhóm chat](#6-quản-lý-hội-thoại--nhóm-chat)
7. [Quản lý bạn bè & Tìm kiếm danh bạ](#7-quản-lý-bạn-bè--tìm-kiếm-danh-bạ)
8. [Các chức năng nâng cao (Poll, Lời nhắc)](#8-các-chức-năng-nâng-cao-poll-lời-nhắc)
9. [Mẫu Bot Hoàn Chỉnh](#9-mẫu-bot-hoàn-chỉnh)

---

## 1. Giới thiệu & Nguyên lý hoạt động

`zca-js` hoạt động dựa trên việc giả lập các request HTTP và kết nối WebSocket của Zalo Web (`chat.zalo.me`). 
* **Cơ chế API**: Đóng gói các tham số dưới định dạng JSON, mã hóa AES thông qua khóa bí mật `zpw_enk` được cấp sau khi xác thực thành công, sau đó gửi các POST request đến các endpoint phục vụ của Zalo.
* **Cơ chế Lắng nghe**: Kết nối đến hệ thống WebSocket của Zalo (`zpw_ws`) để nhận sự kiện thời gian thực (tin nhắn mới, sự kiện đã xem/nhận, trạng thái soạn thảo, thay đổi nhóm).

---

## 2. Cài đặt & Nâng cấp lên V2

### Cài đặt thư viện
Thư viện hoạt động tốt nhất trên môi trường **Bun** (khuyến nghị) hoặc **Node.js** (phiên bản `>= 18`).

```bash
bun add zca-js
# hoặc sử dụng npm
npm install zca-js
```

### Điểm lưu ý quan trọng khi nâng cấp lên V2
Kể từ phiên bản `2.0.0`, thư viện đã loại bỏ dependency `sharp` mặc định để giảm dung lượng cài đặt. Nếu bạn muốn gửi hình ảnh hoặc ảnh động GIF bằng **đường dẫn file cục bộ**, bạn cần tự định nghĩa hàm trích xuất metadata hình ảnh (`imageMetadataGetter`) khi khởi tạo lớp `Zalo`.

**Ví dụ sử dụng `sharp` để trích xuất metadata:**

```bash
bun add sharp
# hoặc sử dụng npm
npm install sharp
```

```typescript
import { Zalo } from "zca-js";
import sharp from "sharp";
import fs from "node:fs";

async function imageMetadataGetter(filePath: string) {
    const data = await fs.promises.readFile(filePath);
    const metadata = await sharp(data).metadata();
    return {
        height: metadata.height || 0,
        width: metadata.width || 0,
        size: metadata.size || data.length,
    };
}

const zalo = new Zalo({
    imageMetadataGetter, // Truyền hàm này vào options của Zalo
});
```

---

## 3. Các phương thức đăng nhập

Thư viện hỗ trợ hai cơ chế đăng nhập chính: Đăng nhập bằng phiên đã có sẵn (Cookie & IMEI) hoặc quét mã QR.

### Đăng nhập bằng Cookie & IMEI
Đây là cách đăng nhập nhanh và ổn định nhất sau khi bạn đã lưu lại thông tin phiên trước đó.

```typescript
import { Zalo, Credentials } from "zca-js";

const zalo = new Zalo();

const credentials: Credentials = {
    imei: "imei_chuỗi_uuid_giả_lập",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    cookie: [
        {
            name: "zpw_sek",
            value: "giá_trị_cookie_phiên",
            domain: "chat.zalo.me",
            path: "/",
            // ... các thuộc tính cookie khác
        }
    ]
};

const api = await zalo.login(credentials);
console.log("Đăng nhập thành công, ID người dùng:", api.getContext().uid);
```

### Đăng nhập bằng mã QR (loginQR)
Khi chưa có thông tin phiên, bạn có thể gọi đăng nhập QR. Thư viện sẽ tạo ảnh QR và cung cấp callback giúp bạn lấy lại thông tin đăng nhập mới để lưu trữ.

```typescript
import { Zalo } from "zca-js";
import fs from "node:fs";

const zalo = new Zalo();

const api = await zalo.loginQR(
    {
        qrPath: "./qr.png", // Đường dẫn lưu file ảnh QR để quét
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"
    },
    (event) => {
        // Sự kiện xảy ra trong quá trình quét QR (ví dụ: GotLoginInfo)
        if (event.type === "GotLoginInfo") {
            console.log("Đã quét thành công! Nhận thông tin đăng nhập:");
            // Ghi lại thông tin credentials để lần sau dùng zalo.login() không cần quét lại
            fs.writeFileSync("./credentials.json", JSON.stringify(event.data, null, 2));
        }
    }
);

console.log("Đã đăng nhập thành công qua mã QR!");
```

### Đăng nhập nhiều tài khoản
Để chạy nhiều tài khoản Zalo đồng thời, hãy tạo nhiều thực thể `Zalo` riêng biệt và giữ các đối tượng `api` khác nhau.

```typescript
const zaloAccount1 = new Zalo();
const api1 = await zaloAccount1.login(credentials1);

const zaloAccount2 = new Zalo();
const api2 = await zaloAccount2.login(credentials2);
```

### Cấu hình sử dụng Proxy
Khi sử dụng proxy (đặc biệt khi chạy nhiều tài khoản để tránh bị Zalo chặn IP), bạn cần cài đặt `node-fetch` hoặc sử dụng một polyfill `fetch` hỗ trợ Agent.

```typescript
import { Zalo } from "zca-js";
import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";

const proxyAgent = new HttpsProxyAgent("http://user:password@proxy-ip:port");

const zalo = new Zalo({
    polyfill: fetch, // sử dụng node-fetch thay cho global fetch
    agent: proxyAgent // truyền proxy agent vào cấu hình
});

const api = await zalo.login(credentials);
```

---

## 4. Lắng nghe sự kiện Realtime (WebSocket Listener)

Sau khi đăng nhập và có thực thể `api`, bạn có thể lấy thuộc tính `api.listener` để xử lý các sự kiện thời gian thực.

> [!IMPORTANT]
> Chỉ được chạy **duy nhất 1 listener** cho mỗi tài khoản tại một thời điểm. Nếu bạn mở ứng dụng Zalo trên trình duyệt Web hoặc PC song song khi listener đang chạy, Zalo Web sẽ ngắt kết nối của listener để bảo mật.

```typescript
const { listener } = api;

// 1. Lắng nghe tin nhắn mới
listener.on("message", (message) => {
    // Phân loại nguồn tin nhắn
    const isUser = message.type === ThreadType.User;   // Tin nhắn cá nhân 1-1
    const isGroup = message.type === ThreadType.Group; // Tin nhắn nhóm

    if (message.isSelf) return; // Bỏ qua nếu là tin nhắn của chính mình gửi đi

    console.log(`Nhận tin nhắn từ ${message.threadId}:`, message.data.content);
});

// 2. Lắng nghe trạng thái kết nối
listener.onConnected(() => {
    console.log("Kết nối WebSocket thành công đến Zalo Server!");
});

listener.onClosed(() => {
    console.log("Kết nối WebSocket bị ngắt!");
});

listener.onError((error) => {
    console.error("Lỗi WebSocket:", error);
});

// Bắt đầu lắng nghe
listener.start();
```

---

## 5. Các hàm API gửi tin nhắn & Tương tác

### Gửi tin nhắn (Văn bản & Trích dẫn)
Hàm `sendMessage` cực kỳ linh hoạt, hỗ trợ định dạng text thô, mention thành viên và trả lời trích dẫn tin nhắn.

```typescript
// Gửi văn bản đơn giản
await api.sendMessage(
    { msg: "Xin chào bạn!" }, 
    message.threadId, 
    message.type // ThreadType.User hoặc ThreadType.Group
);

// Gửi tin nhắn kèm theo Mention (chỉ dành cho Nhóm)
await api.sendMessage(
    {
        msg: "Chào @Nam và @Hoa !",
        mentions: [
            { uid: "id_cua_nam", pos: 5, len: 4 }, // len: độ dài chuỗi bao gồm ký tự @
            { uid: "id_cua_hoa", pos: 15, len: 4 }
        ]
    },
    message.threadId,
    ThreadType.Group
);

// Trả lời trích dẫn tin nhắn khác (Reply)
await api.sendMessage(
    {
        msg: "Tôi đã nhận được tin nhắn của bạn",
        quote: message.data // Đối tượng tin nhắn gốc muốn trích dẫn
    },
    message.threadId,
    message.type
);
```

### Gửi hình ảnh & Sticker
* **Gửi Sticker**: Cần lấy ID nhóm sticker hoặc tìm kiếm ID sticker.
* **Gửi Hình ảnh**: Hỗ trợ gửi hình ảnh qua URL hoặc qua đường dẫn file cục bộ (cần cấu hình `imageMetadataGetter` ở V2).

```typescript
// 1. Gửi nhãn dán (Sticker)
const stickerIds = await api.getStickers("hello"); // Tìm sticker với từ khóa "hello"
if (stickerIds.length > 0) {
    const stickerObj = await api.getStickersDetail(stickerIds[0]);
    await api.sendSticker(stickerObj, message.threadId, message.type);
}

// 2. Gửi hình ảnh qua URL
await api.sendMessage(
    {
        msg: "Đây là ảnh gửi từ URL",
        attachment: {
            url: "https://example.com/image.png",
            type: "image"
        }
    },
    message.threadId,
    message.type
);

// 3. Gửi hình ảnh qua đường dẫn file cục bộ (cần imageMetadataGetter)
await api.sendMessage(
    {
        msg: "Đây là ảnh gửi từ máy tính",
        attachment: {
            filePath: "./photo.jpg",
            type: "image"
        }
    },
    message.threadId,
    message.type
);
```

### Gửi Video, File & Voice thoại
* **Gửi tệp tin thường**: Định dạng `file` qua hàm `uploadAttachment` trước hoặc đính kèm.
* **Gửi Video**: Hàm `sendVideo` riêng biệt.
* **Gửi Voice (tin nhắn thoại)**: Sử dụng hàm `sendVoice`.

```typescript
// Gửi file tài liệu (.pdf, .docx, .zip) từ máy tính
await api.sendMessage(
    {
        attachment: {
            filePath: "./document.pdf",
            type: "file" // Định dạng file đính kèm
        }
    },
    message.threadId,
    message.type
);

// Gửi Video cục bộ kèm ảnh Thumbnail
await api.sendVideo(
    {
        filePath: "./my_video.mp4",
        thumbnailPath: "./thumbnail.jpg", // Ảnh nhỏ xem trước
        duration: 15 // thời lượng video (giây)
    },
    message.threadId,
    message.type
);

// Gửi tin nhắn thoại (Voice)
await api.sendVoice(
    {
        filePath: "./voice_note.mp3",
        duration: 5000 // thời lượng ghi âm (mili-giây)
    },
    message.threadId,
    message.type
);
```

### Thả cảm xúc & Thu hồi tin nhắn
* **Reaction**: Thả biểu tượng cảm xúc lên tin nhắn bất kỳ.
* **Undo**: Thu hồi tin nhắn (chỉ hoạt động với tin nhắn của bạn đã gửi và trong thời gian Zalo cho phép).

```typescript
// 1. Thả emoji cảm xúc
await api.addReaction(
    "❤️", // Emoji muốn thả
    message.data, // Đối tượng tin nhắn gốc nhận cảm xúc
    message.threadId,
    message.type
);

// 2. Thu hồi tin nhắn của chính mình
const sentMessage = await api.sendMessage({ msg: "Tin nhắn nhầm" }, message.threadId, message.type);
// Thu hồi ngay lập tức
await api.undo(sentMessage);

// 3. Xóa tin nhắn ở phía của bạn (chỉ ẩn đi ở tài khoản của bạn)
await api.deleteMessage(message.data, message.threadId, message.type);
```

---

## 6. Quản lý hội thoại & Nhóm chat

`zca-js` cung cấp tập hợp đầy đủ các API quản lý vòng đời nhóm chat:

```typescript
// 1. Tạo nhóm mới
const newGroup = await api.createGroup({
    name: "Nhóm Chat Gia Đình",
    members: ["id_thanh_vien_1", "id_thanh_vien_2"]
});
console.log("Đã tạo nhóm có ID:", newGroup.groupId);

// 2. Thêm thành viên vào nhóm
await api.addUserToGroup("id_thanh_vien_moi", "id_nhom_zalo");

// 3. Xóa thành viên khỏi nhóm
await api.removeUserFromGroup("id_thanh_vien_can_xoa", "id_nhom_zalo");

// 4. Lấy danh sách thành viên nhóm
const membersInfo = await api.getGroupMembersInfo("id_nhom_zalo");
console.log("Danh sách thành viên:", membersInfo);

// 5. Thay đổi thông tin nhóm
await api.changeGroupName("Tên Nhóm Mới", "id_nhom_zalo");
await api.changeGroupAvatar("./group_new_avatar.jpg", "id_nhom_zalo");

// 6. Bổ nhiệm Phó nhóm / Chuyển quyền Trưởng nhóm
await api.addGroupDeputy("id_thanh_vien", "id_nhom_zalo"); // Phó nhóm
await api.changeGroupOwner("id_chu_nhom_moi", "id_nhom_zalo"); // Trưởng nhóm mới

// 7. Rời khỏi nhóm
await api.leaveGroup("id_nhom_zalo");
```

---

## 7. Quản lý bạn bè & Tìm kiếm danh bạ

```typescript
// Lấy thông tin tài khoản cá nhân của chính mình
const myInfo = await api.fetchAccountInfo();
console.log("Tài khoản của tôi:", myInfo);

// Tìm kiếm người dùng qua số điện thoại
const searchResult = await api.findUser("8490xxxxxxx"); // Định dạng số điện thoại Việt Nam bắt đầu bằng 84
if (searchResult) {
    console.log("Tìm thấy người dùng:", searchResult.uid, searchResult.dpName);
}

// Lấy danh sách toàn bộ bạn bè trong danh bạ
const allFriends = await api.getAllFriends();
console.log("Số lượng bạn bè:", allFriends.length);

// Quản lý kết bạn
await api.sendFriendRequest("Lời chào kết bạn!", "id_nguoi_nhan");
await api.acceptFriendRequest("id_nguoi_gui"); // Đồng ý kết bạn
await api.rejectFriendRequest("id_nguoi_gui"); // Từ chối kết bạn
await api.removeFriend("id_ban_be"); // Xóa bạn bè
```

---

## 8. Các chức năng nâng cao (Poll, Lời nhắc)

### Tạo Cuộc bình chọn (Poll) trong nhóm
```typescript
await api.createPoll({
    question: "Hôm nay ăn gì?",
    options: ["Bún chả", "Cơm tấm", "Phở bò"],
    groupId: "id_nhom_zalo",
    // Cấu hình nâng cao (tùy chọn)
    allowMultiChoices: true, // Cho phép chọn nhiều
    allowAddOptions: true,   // Cho phép người khác thêm tùy chọn
    hideVote: false          // Không ẩn danh người bình chọn
});
```

### Tạo lời nhắc (Reminder) hẹn giờ
```typescript
await api.createReminder({
    title: "Cuộc họp định kỳ hàng tuần",
    time: Date.now() + 24 * 60 * 60 * 1000, // Nhắc nhở sau 24 giờ nữa
    type: "once", // "once" (một lần) hoặc "daily" (mỗi ngày), "weekly" (mỗi tuần)
    groupId: "id_nhom_zalo", // Hoặc threadId của cá nhân
    remindTimeBefore: 15 * 60 * 1000 // Nhắc trước 15 phút
});
```

---

## 9. Mẫu Bot Hoàn Chỉnh

### 1. Echo Bot (Phản hồi tin nhắn tự động)
Bot sẽ tự động gửi lại nội dung tin nhắn mà nó nhận được từ người dùng hoặc nhóm.

```typescript
import { Zalo, ThreadType } from "zca-js";
import fs from "node:fs";

const zalo = new Zalo();
const credentialsPath = "./credentials.json";

// Hàm tiện ích kiểm tra thông tin phiên
function getCredentials() {
    if (!fs.existsSync(credentialsPath)) return null;
    return JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
}

const savedCredentials = getCredentials();
const api = savedCredentials 
    ? await zalo.login(savedCredentials) 
    : await zalo.loginQR({}, (event) => {
        if (event.type === "GotLoginInfo") {
            fs.writeFileSync(credentialsPath, JSON.stringify(event.data, null, 2));
        }
      });

const { listener } = api;

listener.on("message", (message) => {
    // Chỉ phản hồi nếu tin nhắn không phải do chính mình gửi đi và là định dạng chuỗi văn bản
    if (message.isSelf || typeof message.data.content !== "string") return;

    const replyMsg = `[Auto-Bot] Bạn vừa nói: "${message.data.content}"`;

    // Gửi phản hồi trích dẫn (reply)
    api.sendMessage(
        {
            msg: replyMsg,
            quote: message.data
        },
        message.threadId,
        message.type
    );
});

listener.onConnected(() => console.log("Echo Bot đang chạy và lắng nghe..."));
listener.start();
```

### 2. Welcome Bot (Chào mừng thành viên mới vào nhóm)
Bot tự động gửi tin nhắn chào mừng kèm theo nhắc tên (mention) khi có một thành viên mới tham gia vào nhóm chat.

```typescript
import { Zalo, ThreadType } from "zca-js";

// Khởi chạy với thông tin session có sẵn
const zalo = new Zalo();
const api = await zalo.login(JSON.parse(fs.readFileSync("./credentials.json", "utf-8")));
const { listener } = api;

listener.on("groupEvent", async (event) => {
    // Kiểm tra sự kiện có thành viên mới tham gia nhóm
    // Trong Zalo, sự kiện thành viên mới thường đi kèm kiểu event cụ thể hoặc tin nhắn hệ thống
    console.log("Nhận sự kiện nhóm:", event);
    
    // Lưu ý: Tùy theo cấu trúc gói tin Zalo, bạn cần phân tích các sự kiện trong event.data
    // Ví dụ: Kiểm tra kiểu hoạt động thêm thành viên
    if (event.data && event.data.type === "add_member") {
        const newMemberId = event.data.memberId;
        const groupInfo = await api.getGroupInfo(event.threadId);
        
        const welcomeText = `Chào mừng @Thành Viên Mới đã tham gia vào nhóm ${groupInfo.name}! Hãy đọc nội quy nhóm nhé.`;
        
        await api.sendMessage(
            {
                msg: welcomeText,
                mentions: [
                    { uid: newMemberId, pos: 8, len: 15 } // Vị trí pos tương ứng với chuỗi @Thành Viên Mới
                ]
            },
            event.threadId,
            ThreadType.Group
        );
    }
});

listener.start();
```

---
*Tài liệu này được biên soạn cho dự án [zca-js](file:///d:/Project/zca-js) phục vụ tham khảo và tích hợp phát triển.*
