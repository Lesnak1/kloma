# Yarışma implementation ve işletim planı

Amaç, Loaf’ın açıkladığı hacim bazlı puanlama altında kontrollü puan üretirken fee-sonrası edge’i ve haftalık alt %30 eliminasyon savunmasını birlikte optimize etmektir. Ödül veya kâr garantisi verilemez.

## Points-v3 çalışma ilkesi

- Her `$1` işlem hacmi puan ürettiği için bot tüm LIVE marketleri tarar ve yayınlanan global volume multiplier eşiklerini takip eder.
- Points emirleri `%0,5` baz notional, market başına `%3` envanter tavanı ve yakın bid likiditesinin `%15` katılım sınırıyla pasif kalır.
- Tahmini round-trip maliyeti `POINTS_MAX_ROUND_TRIP_COST_BPS` bütçesini aşarsa veya 5m/15m yapı belirgin bearish ise yeni points alışı açılmaz.
- Drawdown `%2` olduğunda points girişleri kapanır; normal pozisyon çıkışları ve hard `%6` cancel-all koruması çalışmaya devam eder.
- Mevcut envanteri azaltan SELL emirleri, yeni BUY emirlerinden önce gönderilir.
- Leaderboard/multiplier şeması eksikse bonus varsayılmaz; bot `1x` ve `balanced` modda kalır.

## Faz 0 — Secret ve altyapı

- Sohbette paylaşılan Loaf key revoke edilir; yenisi sadece Vercel Production secret olur.
- Vercel deploy, Upstash Redis, cron-job.org dakikalık job ve `CRONJOB_JOB_ID` geri-beslemesi tamamlanır.
- `REQUIRE_DURABLE_LOCK=true`; `/api/status` üç operasyonel bileşeni de configured göstermelidir.
- `TRADING_ENABLED=false`, `ALLOW_OUTSIDE_COMPETITION=false`, `KILL_SWITCH=false` kalır.
- Unauthorized endpoint çağrısı 401; `/api/status` ve `/api/tick` yetkili çağrısı 200 vermelidir.
- cron-job.org’da job response saklama kapalı, failure notification açık doğrulanır.

Çıkış kriteri: build/test yeşil, dakikalık heartbeat görünür, hiçbir trade write yok.

## Faz 1 — Aktif tur dry-run kalibrasyonu

- `competition.admitted=true`, başlangıç bakiyesi, `roundRules`, fee, multiplier ve yarışma marketleri doğrulanır.
- En az 24 saat spread, volatility, momentum, quote fiyat/miktarı ve karar nedeni izlenir.
- `/api/telemetry`, `npm run replay` ve `npm run market:audit` ile her marketin sample, accuracy, likidite ve iki-maker-fee sonrası edge’i ölçülür.
- Kalibrasyon 15–45 dakikalık ileri mid değişimini ölçer; 5 dakikalık sinyal ayrıca 15 dakikalık trendle doğrulanır.
- Ciddi negatif ücret-sonrası edge veya düşük doğruluk üreten market yeni alışlar için karantinaya alınır; recovery ölçümü için sinyal gözlemi sürer.
- Stale/bozuk book’ta quote, crossed fiyat, pozisyondan fazla sell veya minimum notional ihlali olmamalıdır.

Çıkış kriteri: veri şeması kararlı ve teorik fee-sonrası beklenti pozitif.

## Faz 2 — Micro-live

```text
TRADING_ENABLED=true
ORDER_NOTIONAL_PCT=0.25
MAX_MARKETS_PER_TICK=1
MAX_ORDERS_PER_TICK=2
MAX_GROSS_EXPOSURE_PCT=10
MAX_MARKET_EXPOSURE_PCT=5
CASH_RESERVE_PCT=60
```

- API accept’in fill olmadığı portfolio/order history ile doğrulanır.
- Her order yeni nonce kullanmalı; stale order bir kez iptal edilmeli; fresh eşdeğer order korunmalıdır.
- En az 20 fill veya 24 saat maker/taker fee sonrası PnL, slippage, fill ve reject oranı ölçülür.
- Beklenmeyen 401/403/429, tekrarlayan 5xx veya schema drift halinde `KILL_SWITCH=true` yapılır.

Çıkış kriteri: hard risk ihlali yok, ücret sonrası sonuç kabul edilebilir.

## Faz 3 — Kontrollü ölçekleme

- Notional tek adımda en fazla 2x artırılır; adımlar arasında en az 20 yeni fill gözlenir.
- Marketler fee-sonrası edge ve adverse selection ile sıralanır; önce 2, sonra en çok 4 market.
- İlk %35’te `preserve`, %35–55’te `balanced`, %55–70’te `defend`, alt %30’da sınırlı `attack` uygulanır.
- Drawdown %4’te manuel inceleme; `MAX_DRAWDOWN_PCT` seviyesinde otomatik cancel-all ve halt.

## Haftalık eliminasyon savunması

- Bottom-30 sınırı ve rank tamponu her heartbeat’te değerlendirilir.
- Güvenli bölgede gross risk düşürülür; sınır yakınında yalnızca pozitif fee-edge marketlerde ölçülü sizing artar.
- Son saatlerde incelen likiditede market order kovalanmaz; skor uğruna wash/self trade yapılmaz.
- Tur sonuna yakın `STOP_AFTER_ROUND_NUMBER` ve scheduler credential’ları tekrar doğrulanır.

## KPI’lar

| KPI | Karar |
|---|---|
| Fee-sonrası realized PnL | Ekonomik sonuç |
| Rank ve cutoff mesafesi | Eliminasyon riski |
| 5/15 dk adverse selection | Quote kalitesi |
| Maker fill oranı | Pasif strateji etkinliği |
| Cancel/replace oranı | Churn ve rate-limit riski |
| 401/403/429/5xx oranı | API/credential sağlığı |
| Gross ve market exposure | Risk uyumu |
| Drawdown | Devre kesici girdisi |

## Yarışma sonu

1. Hedef round terminal olduğunda bot açık emirleri okur.
2. Live modda `cancelAll` çalışır; başarısız iptal varsa scheduler kapanmaz ve bir sonraki dakika tekrar kontrol eder.
3. Açık emir kalmadığı doğrulanınca cron-job.org job disable edilir.
4. Bağımsız olarak Loaf UI/API’den active orders ve portfolio kontrol edilir.
5. Vercel’de `TRADING_ENABLED=false`, `KILL_SWITCH=true`; secret’lar rotate/revoke edilir.

## Vercel’in yetmediği eşik

Dakikalık scheduler fırsatların çoğunu kaçırıyor veya adverse selection yaratıyorsa stratejiyi gereksiz riskle zorlamayın. Resmî 5 saniyelik WebSocket loop için sürekli çalışan container/VPS gerekir; Vercel Hobby üzerinde kalıcı process vaadi teknik olarak doğru değildir.
