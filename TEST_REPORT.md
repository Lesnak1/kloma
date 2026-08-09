# Expert test raporu

## 9 Ağustos 2026 — compound-v4 canlı audit (en güncel)

### Ölçülen production sonucu

- Hesap değeri: `129.608,29 USDL`; başlangıç sermayesine göre toplam getiri: `+29.608,29 USDL` (`+%29,61`).
- Mevcut pozisyonların unrealized PnL toplamı: `+2.539,26 USDL`.
- Tek dış nakit hareketi `100.000 USDL` başlangıç transferi olduğundan yaklaşık realized kazanç `27.069,03 USDL` olarak hesaplanır. Bu değer Loaf'ın ayrıca yayınladığı realized-PnL alanı değil, cash-flow mutabakatından türetilmiş bir tahmindir.
- Lifetime volume: `7.810.643,76 USDL`.
- API'nin erişilebilir son `10.000` fill penceresi: `5.469.677,82 USDL` hacim ve `2.967,55 USDL` fee.
- İncelenen bir saatlik üretim penceresinde `353` kabul edilmiş emir yazımına karşılık `136` gerçek fill oluştu (`%38,5` fill/admission oranı). API'de `success=true`, fill garantisi değildir.
- Açık pozisyonların tamamı audit anında kârlıydı; en yüksek açık getiriler Monaco (`+%16,10`) ve Liberty (`+%11,66`) oldu.

### Bulunan üretim sorunları ve compound-v4 düzeltmeleri

- Upstash'teki `8.996` ayrıntılı run kaydı yaklaşık `104,9 MB` kullanarak free-tier depolama sınırına ulaştı; yeni telemetry yazımı 502 üretmeye başladı. Retention `2.000` kayıt hard cap'ine indirildi ve pipeline, yeni kaydı yazmadan önce eski kayıtları kırpacak şekilde sıralandı.
- Stop-loss emirlerinde `IOC` Loaf production doğrulamasından dönüyordu. Stop-loss artık güncel best bid'de marketable `GTC` limit olarak gönderiliyor.
- Competition API round döndürmediğinde high-water mark okunmuyordu. Null-round peak artık kalıcı tutuluyor; `129k` seviyesinden olası drawdown başlangıçtaki `100k` yerine gerçek peak'e göre korunuyor.
- Points baz büyüklüğü equity'nin `%0,50` seviyesinden `%0,60` seviyesine çıkarıldı.
- Compounding açık, kâr reinvest oranı `%100`, sizing equity tavanı başlangıç sermayesinin `1,5×` değeri. Zarar halinde boyut gerçek equity ile otomatik küçülür.
- En az 20 gözlem, pozitif fee-sonrası EMA edge ve en az `%50` yön doğruluğu olmayan piyasaya ek size boost verilmez. Uygun piyasada toplam kalite ölçeği en fazla `1,35×` olur.
- Mevcut hard sınırlar korunur: `%25` cash reserve, `%60` gross exposure, `%12` normal market exposure, `%3` points inventory ve `%6` high-water drawdown halt.

### Platform durumu

Audit anında resmi competition endpoint'i aktif round döndürmüyor, League sayfası upgrade/maintenance gösteriyor ve 10/10 market halted durumunda. Bu yüzden botun yeni emir üretmemesi beklenen fail-safe davranıştır; piyasa açıldığında cron tick'leri yeniden değerlendirme yapar.

### Compound-v4 otomatik doğrulama

- `48/48` test geçti.
- `2.000` deterministik piyasa/risk senaryosu invariant ihlali olmadan geçti.
- Satır coverage: `%91,58`; branch coverage: `%78,43`; function coverage: `%88,73`.
- TypeScript kontrolü ve optimize Next.js production build başarılı.
- Doğrulanan yeni davranışlar: kontrollü compounding cap, yalnızca pozitif kalitede size boost, null-round high-water breaker, Redis pre-trim ve Loaf uyumlu marketable GTC stop-loss.

## Önceki points-v3 baseline — 2 Ağustos 2026

Tarih: 2 Ağustos 2026 (Europe/Istanbul)

## Sonuç

Points-v3 kodu, yerel production build ve gerçek Loaf testnetinin read-only endpointleri için testler geçti. Trading gate nonce isteğiyle `HTTP 200` doğrulandı; strateji audit’i emir göndermeden tamamlandı. Henüz uygun sinyal/fill olmadığı için gerçek order yaşam döngüsü doğrulanmadı.

## Otomatik testler

- 39/39 senaryo geçti.
- 2.000 deterministik piyasa kombinasyonu fuzz/invariant testinden geçti.
- Satır coverage: %90,02.
- Branch coverage: %77,11.
- Function coverage: %86,67.
- Coverage kapıları: satır ≥%90, branch ≥%70, function ≥%80.

Doğrulanan başlıca invariantlar:

- Limit fiyatları tick-size ile uyumlu ve book’u yanlışlıkla cross etmiyor.
- Miktar en fazla bir ondalık hassasiyetinde.
- Minimum notional korunuyor.
- Sell miktarı mevcut pozisyonu aşmıyor; short açılmıyor.
- Aynı kararda bid ve ask self-trade yaratmıyor.
- Nakit, gross exposure ve market exposure bütçeleri aşılmıyor.
- Kalıcı kaybeden sinyal size’ı düşürüp edge eşiğini yükseltiyor.
- Aşırı negatif market kalibrasyonu yeni envanteri karantinaya alırken recovery ölçümünü sürdürüyor.
- Beş dakikalık mumlar deterministik 15 dakikalık OHLCV barlarına çevriliyor.
- Dinamik take-profit tam pozisyonu pasif ve non-crossing emirle kapatıyor.
- Emir notional’i yakın bid likiditesinin belirlenen katılım yüzdesini aşmıyor.
- Drawdown breaker yalnızca round başlangıcını değil kalıcı round peak değerini de koruyor.
- Admission yoksa portfolio/market/order write katmanına geçilmiyor.
- Drawdown ve kill switch market değerlendirmesinden önce cancel-all yoluna giriyor.
- Read-only 429/503 çağrıları sınırlı retry alırken nonce/order/cancel write çağrıları retry almıyor.
- Her order submission yeni nonce kullanıyor.
- Eksik distributed state veya leaderboard identity ile live mod fail-closed duruyor.
- Bearer secret tam eşleşme gerektiriyor; query-string secret kabul edilmiyor.
- Bozuk Redis state fail-closed hata üretiyor.
- Global volume multiplier eşikleri mevcut hacme göre seçiliyor; bilinmeyen şema bonus üretmiyor.
- Points emirleri ayrı notional/market-exposure/drawdown/maliyet bütçelerine uyuyor.
- Points envanteri pasif satışla geri dönüştürülüyor ve SELL emirleri yeni BUY emirlerinden önce gönderiliyor.

Komut:

```bash
npm run test:coverage
```

## Gerçek Loaf read-only contract testi

Verilen API key process environment üzerinden geçici kullanıldı; dosyaya veya repoya yazılmadı.

Son doğrulanan durum:

| Alan | Sonuç |
|---|---:|
| API contract | PASS |
| Bakiye | 100.000 USDL |
| Pozisyon | 0 |
| Açık emir | 0 |
| Aktif round | Yok |
| Queue | 5.862 / 6.588 |
| Canlı market | 10/10 doğrulandı |
| İki taraflı order book | 10/10 |
| Candle | 1.200/1.200 doğrulandı |
| Contract warning | 0 |
| Maker/taker fee | 40/70 bps |

Komut:

```bash
npm run contract
```

Bu script yalnızca GET/read endpointlerini çağırır.

`npm run market:audit` ile aynı 10 market points-v3 üzerinde ayrıca tarandı; 10/10 market verisi işlendi ve çalışma salt-okunur kaldı. Son audit’te başlangıç kalibrasyonuyla Eiffel, Yongin ve Goldengate küçük pasif points adayı üretti; production kalıcı kalibrasyonunda Eiffel karantinada olduğu için beklenen aktif adaylar Yongin ve Goldengate’tir. Örnek emir notional’leri yaklaşık 280–320 USDL aralığındadır.

## Production endpoint smoke testi

Optimize edilmiş Next.js build, yerel production server üzerinde gerçek read-only Loaf verisiyle çalıştırıldı.

| Test | Sonuç |
|---|---:|
| `/` | HTTP 200 |
| Yetkisiz `/api/status` | HTTP 401 |
| Yetkili `/api/status` | HTTP 200 |
| Yetkisiz `/api/tick` | HTTP 401 |
| Yetkili compact `/api/tick` | HTTP 200 |
| Tick mode | `dry-run` |
| Competition active | `false` |
| Cache policy | `no-store` |

## Concurrency testi

Production `/api/tick` endpointine aynı anda 25 yetkili dry-run istek gönderildi:

- 25/25 HTTP 200.
- Toplam süre: 2.022 ms.
- 25 cevapta tek `runId`: instance-içi `inFlight` deduplication doğrulandı.
- Trade write yapılmadı.

Vercel Production üzerinde gerçek Upstash kalıcı state ve distributed lock yapılandırması ayrıca doğrulandı; cron tick kayıtları Redis telemetrisinde görünmektedir.

## Build ve güvenlik

- TypeScript: PASS.
- Next.js production build: PASS.
- npm production audit: 0 vulnerability.
- Workspace secret pattern taraması: gerçek 64-hex key bulunmadı.
- Git whitespace kontrolü: PASS.

## Henüz doğrulanamayanlar

Şu maddeler dış sistem durumu/credential gerektirir ve live açılmadan tamamlanmalıdır:

1. Competition endpoint’inin aktif round ve gerçek leaderboard verisini yayınlaması.
2. Leaderboard satırının `LOAF_HANDLE` veya `LOAF_WALLET_ADDRESS` ile eşleşmesi.
3. Points-v3 limit order’ın accepted → active → fill/cancel yaşam döngüsü.
4. En az 20 gerçek fill sonrası fee-sonrası ve points-per-cost replay.

Bu dört kapı tamamlanmadan yarışma içinde agresif ölçeklemeye geçilmemelidir.
