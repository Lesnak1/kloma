# Expert test raporu

Tarih: 1 Ağustos 2026 (Europe/Istanbul)

## Sonuç

Kod, yerel production build ve gerçek Loaf testnetinin read-only endpointleri için testler geçti. Gerçek emir write testi özellikle yapılmadı; aktif round ve admission olmadığı için bunu yapmak güvenli veya anlamlı değildir.

## Otomatik testler

- 30/30 senaryo geçti.
- 2.000 deterministik piyasa kombinasyonu fuzz/invariant testinden geçti.
- Satır coverage: %90,11.
- Branch coverage: %73,26.
- Function coverage: %86,35.
- Coverage kapıları: satır ≥%90, branch ≥%70, function ≥%80.

Doğrulanan başlıca invariantlar:

- Limit fiyatları tick-size ile uyumlu ve book’u yanlışlıkla cross etmiyor.
- Miktar en fazla bir ondalık hassasiyetinde.
- Minimum notional korunuyor.
- Sell miktarı mevcut pozisyonu aşmıyor; short açılmıyor.
- Aynı kararda bid ve ask self-trade yaratmıyor.
- Nakit, gross exposure ve market exposure bütçeleri aşılmıyor.
- Kalıcı kaybeden sinyal size’ı düşürüp edge eşiğini yükseltiyor.
- Admission yoksa portfolio/market/order write katmanına geçilmiyor.
- Drawdown ve kill switch market değerlendirmesinden önce cancel-all yoluna giriyor.
- Read-only 429/503 çağrıları sınırlı retry alırken nonce/order/cancel write çağrıları retry almıyor.
- Her order submission yeni nonce kullanıyor.
- Eksik distributed state veya leaderboard identity ile live mod fail-closed duruyor.
- Bearer secret tam eşleşme gerektiriyor; query-string secret kabul edilmiyor.
- Bozuk Redis state fail-closed hata üretiyor.

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
| Queue | 5.845 / 5.982 |
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

Vercel instance’ları arası deduplication, deploy sonrası gerçek Upstash credential’larıyla ayrıca doğrulanmalıdır.

## Build ve güvenlik

- TypeScript: PASS.
- Next.js production build: PASS.
- npm production audit: 0 vulnerability.
- Workspace secret pattern taraması: gerçek 64-hex key bulunmadı.
- Git whitespace kontrolü: PASS.

## Henüz doğrulanamayanlar

Şu maddeler dış sistem durumu/credential gerektirir ve live açılmadan tamamlanmalıdır:

1. Aktif competition round ve gerçek admission.
2. Leaderboard satırının `LOAF_HANDLE` veya `LOAF_WALLET_ADDRESS` ile eşleşmesi.
3. Vercel Production + gerçek Upstash distributed lock entegrasyonu.
4. cron-job.org job’ın dakikalık execution history’si.
5. Micro-live limit order’ın accepted → active → fill/cancel yaşam döngüsü.
6. En az 24 saat dry-run telemetrisi ve 20 gerçek fill sonrası fee-sonrası replay.

Bu altı kapı tamamlanmadan `TRADING_ENABLED=true` yapılmamalıdır.
