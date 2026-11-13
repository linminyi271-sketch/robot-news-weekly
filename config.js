/*
 * 網站設定檔：日常調整只需要改這裡，不必動其他程式。
 * 修改後存檔、上傳到 GitHub 即生效。
 */
window.SITE_CONFIG = {
  SITE_TITLE: '機器人產業新聞週報',
  SITE_SUBTITLE: 'Robotics Industry Weekly',

  // Google Apps Script 部署後的網址（以 /exec 結尾）。
  // 留空 = 預覽模式：顯示 data/seed.js 的範例資料，新增的內容只存在自己的瀏覽器。
  API_URL: 'https://script.google.com/macros/s/AKfycbyOlKJb0EcB6O3Wj3qa7i4Fmnoi4AmHg7MeMv39anQQHVcpHq7PiEHIpJLtNakisy8p/exec',

  // 上傳時是否需要「團隊上傳碼」。設為 true 時，也要在 Apps Script 的「指令碼屬性」設定 UPLOAD_CODE。
  UPLOAD_CODE_REQUIRED: false,

  // 每期的起始星期：0=週日、1=週一 … 4=週四。目前週報為「週四到下週三」。
  WEEK_START_DAY: 4,

  // 新聞區域（順序即網頁顯示順序）。
  REGIONS: ['國內', '國外'],

  // 主題標籤與自動判斷用的關鍵字（不分大小寫）。
  // 上傳時系統會依標題與摘要自動建議標籤，上傳者可再手動調整。
  TAGS: [
    { name: '人形機器人', keywords: ['人形', 'humanoid', '雙足', 'Figure 0', 'Optimus', '具身智能'] },
    { name: '醫療照護', keywords: ['醫療', '醫院', '照護', '長照', '手術', '病患', '臨床', '復健', '榮總'] },
    { name: 'AI晶片／運算平台', keywords: ['晶片', 'NVIDIA', '輝達', 'Jetson', 'GPU', '伺服器', '算力', 'Omniverse', '運算平台', '數位孿生'] },
    { name: '視覺感測', keywords: ['視覺', '感測', '相機', '影像', '光達', 'LiDAR', '觸覺', '深度感知'] },
    { name: '服務機器人／RaaS', keywords: ['RaaS', '服務機器人', '陪伴', '居家', '家事', '旅宿', '零售', '餐飲', '配送', '清潔'] },
    { name: '企業布局', keywords: ['布局', '成立', '攜手', '合作', '投資', '併購', '量產', '策略', '招募', '新品牌', '研發'] }
  ]
};
