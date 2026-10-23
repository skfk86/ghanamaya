const now = Date.now(), H = 3600e3, D = 24 * H;
const T = (ms) => ({ __ts: ms });
const img = (i) => ({ url: `https://ik.imagekit.io/7uwbsw4wl/listings/a${i % 6}.jpg` });
const L = (id, o) => [`listings/${id}`, { sellerId: 'u2', sellerName: 'مزرعة الرحمة', status: 'active', qty: 1, state: 'الخرطوم', city: 'بحري', description: 'خروف كباشي أصيل، صحته ممتازة، مطعّم ومعلوف علف مركّز. مناسب للأضحية والعقيقة. المعاينة متاحة يومياً بعد العصر.', createdAt: T(now - o.ago), updatedAt: T(now - o.ago), images: [img(o.i), img(o.i + 1), img(o.i + 2)], ...o }];
window.__SEED = {
  user: { uid: 'u1', email: 'ali@example.com', displayName: 'علي' },
  claims: { admin: true },
  docs: Object.fromEntries([
    ['users/u1', { name: 'علي محمد', state: 'الخرطوم', city: 'بحري', isSeller: true, storeName: 'حوش علي للمواشي', whatsapp: '+249912345678', verified: true, rating: 4.8, ratingCount: 23, createdAt: T(now - 90 * D) }],
    ['users/u2', { name: 'عثمان', state: 'الخرطوم', city: 'أم درمان', isSeller: true, storeName: 'مزرعة الرحمة', whatsapp: '+249911111111', verified: true, rating: 4.6, ratingCount: 41, createdAt: T(now - 200 * D) }],
    ['users/u3', { name: 'محمد أحمد', state: 'الجزيرة', city: 'ود مدني', isSeller: false, createdAt: T(now - 20 * D) }],
    L('l1', { type: 'sheep', breed: 'كباشي', sex: 'm', ageMonths: 14, weightKg: 62, price: 450000, ago: 2 * H, i: 0, featuredUntil: T(now + 3 * D) }),
    L('l2', { type: 'sheep', breed: 'حمري', sex: 'm', ageMonths: 10, weightKg: 48, price: 320000, ago: 5 * H, i: 1, city: 'شرق النيل' }),
    L('l3', { type: 'goat', breed: 'شامي', sex: 'f', ageMonths: 18, weightKg: 40, price: 280000, ago: 26 * H, i: 2, qty: 3, sellerId: 'u1', sellerName: 'حوش علي للمواشي' }),
    L('l4', { type: 'goat', breed: 'نوبي', sex: 'm', ageMonths: 8, weightKg: 25, price: 150000, ago: 50 * H, i: 3, state: 'الجزيرة', city: 'ود مدني' }),
    L('l5', { type: 'cattle', breed: 'كناني', sex: 'm', ageMonths: 30, weightKg: 380, price: 2800000, ago: 3 * D, i: 4, state: 'سنار', city: 'سنجة' }),
    L('l6', { type: 'camel', breed: 'عنافي', sex: 'f', ageMonths: 60, weightKg: 450, price: 6500000, ago: 4 * D, i: 5, state: 'كسلا', city: 'كسلا' }),
    L('l7', { type: 'sheep', breed: 'زغاوي', sex: 'f', ageMonths: 12, weightKg: 44, price: 260000, ago: 5 * D, i: 2 }),
    L('l8', { type: 'sheep', breed: 'كباشي', sex: 'm', ageMonths: 20, weightKg: 70, price: 520000, ago: 6 * D, i: 0, status: 'sold' }),
    ['wallets/u1', { balance: 12850, held: 5000 }],
    ['settings/wallet', { sdgPerUsdt: 9000, commissionRate: 0.03, releaseDays: 3, minWithdraw: 500, updatedAt: T(now - 3 * H) }],
    ['chats/l1_u1', { listingId: 'l1', buyerId: 'u1', sellerId: 'u2', participants: ['u1', 'u2'], buyerName: 'علي محمد', sellerName: 'مزرعة الرحمة', listingTitle: 'خروف كباشي', listingImage: img(0).url, listingPrice: 450000, lastMessage: 'عرض سعر: 420,000 ج.س', lastSenderId: 'u1', updatedAt: T(now - 20 * 60e3), readAt: {}, createdAt: T(now - 2 * H) }],
    ['chats/l3_u3', { listingId: 'l3', buyerId: 'u3', sellerId: 'u1', participants: ['u3', 'u1'], buyerName: 'محمد أحمد', sellerName: 'حوش علي للمواشي', listingTitle: 'ماعز شامي', listingImage: img(2).url, listingPrice: 280000, lastMessage: 'هل السعر قابل للتفاوض؟', lastSenderId: 'u3', updatedAt: T(now - 3 * H), readAt: {}, createdAt: T(now - 5 * H) }],
    ['chats/l1_u1/messages/m1', { senderId: 'u1', kind: 'text', text: 'السلام عليكم، الخروف لسه متاح؟', createdAt: T(now - 2 * H) }],
    ['chats/l1_u1/messages/m2', { senderId: 'u2', kind: 'text', text: 'وعليكم السلام، أيوه متاح. تقدر تعاينه في بحري بعد العصر.', createdAt: T(now - 110 * 60e3) }],
    ['chats/l1_u1/messages/m3', { senderId: 'u1', kind: 'offer', offer: { price: 420000, qty: 1, status: 'pending', expiresAt: now + 20 * H }, createdAt: T(now - 20 * 60e3) }],
    ['orders/o1', { listingId: 'l1', buyerId: 'u1', sellerId: 'u2', participants: ['u1', 'u2'], buyerName: 'علي محمد', sellerName: 'مزرعة الرحمة', title: 'خروف كباشي', image: img(0).url, unitPrice: 450000, qty: 1, total: 450000, paymentMethod: 'wallet', delivery: 'pickup', status: 'accepted', escrow: { amount: 5000, rate: 9000, status: 'held' }, createdAt: T(now - 5 * H), updatedAt: T(now - 3 * H), acceptedAt: T(now - 3 * H) }],
    ['orders/o2', { listingId: 'l3', buyerId: 'u3', sellerId: 'u1', participants: ['u3', 'u1'], buyerName: 'محمد أحمد', sellerName: 'حوش علي للمواشي', title: 'ماعز شامي', image: img(2).url, unitPrice: 280000, qty: 2, total: 560000, paymentMethod: 'bankak', delivery: 'seller', status: 'pending', createdAt: T(now - 1 * H), updatedAt: T(now - 1 * H) }],
    ['orders/o3', { listingId: 'l4', buyerId: 'u1', sellerId: 'u2', participants: ['u1', 'u2'], buyerName: 'علي محمد', sellerName: 'مزرعة الرحمة', title: 'ماعز نوبي', image: img(3).url, unitPrice: 150000, qty: 1, total: 150000, paymentMethod: 'cash', delivery: 'pickup', status: 'completed', createdAt: T(now - 6 * D), updatedAt: T(now - 5 * D) }],
    ['transactions/t1', { uid: 'u1', type: 'deposit', amount: 10000, createdAt: T(now - 3 * D) }],
    ['transactions/t2', { uid: 'u1', type: 'sale', amount: 7850, note: 'ماعز شامي', createdAt: T(now - 2 * D) }],
    ['transactions/t3', { uid: 'u1', type: 'hold', amount: -5000, note: 'خروف كباشي', createdAt: T(now - 5 * H) }],
    ['withdrawals/w1', { uid: 'u1', amount: 2000, address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', status: 'scheduled', releaseAt: T(now + 18 * H), reviewReason: 'عنوان سحب جديد', createdAt: T(now - 6 * H) }],
    ['reviews/o3', { sellerId: 'u2', buyerId: 'u1', buyerName: 'علي محمد', stars: 5, comment: 'بائع أمين والخروف زي الوصف تماماً', title: 'ماعز نوبي', createdAt: T(now - 5 * D) }],
    ['reports/r1', { targetType: 'listing', targetId: 'l7', reporterId: 'u3', subjectUid: 'u2', reason: 'fraud', reasonLabel: 'احتيال أو طلب تحويل قبل المعاينة', priority: 1, status: 'open', title: 'زغاوي · بحري', createdAt: T(now - 2 * H) }],
    ['verifyRequests/u3', { name: 'محمد أحمد', storeName: 'زريبة ود مدني', whatsapp: '+249922222222', state: 'الجزيرة', city: 'ود مدني', note: 'أبيع ضأن منذ 10 سنوات', status: 'pending', createdAt: T(now - 4 * H) }]
  ])
};
