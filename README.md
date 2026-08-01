# Loaf League Trader

Loaf Markets League için Vercel üzerinde çalışan, dakikada bir tetiklenen ve risk kontrollü otomatik testnet trade botu. Motor; order-book microprice/imbalance, 5 dakikalık momentum, realized volatility, referans fiyat sapması, envanter, ücretler ve leaderboard konumunu birlikte değerlendirir.

> Kâr, derece veya ödül garantisi yoktur. Rakipler, likidite, puan formülü ve tur kuralları bilinmeden “kusursuz profitable bot” iddiası gerçekçi değildir. Varsayılan kurulum hiçbir emir göndermez.

## 7/24 mimari

Vercel Function kalıcı bir process veya sürekli WebSocket değildir. Vercel Hobby’nin yerleşik cron sıklığı da bu kullanım için yetersizdir. Bu nedenle ürün şu şekilde çalışır:

```text
cron-job.org (her dakika)
        │  POST + ayrı Bearer secret
        ▼
Vercel /api/tick
        ├── Upstash Redis: distributed lock + telemetry + calibration
        │
        └── Loaf API: market/portfolio/orders/competition
```

- cron-job.org ücretsiz hesapta her dakika çağrı yapabilir; job yanıtlarını saklama kapalıdır.
- `/api/tick` yalnızca `CRON_SECRET` ile çalışır ve scheduler’a küçük bir sağlık cevabı verir.
- Aynı instance içindeki çakışan istekler tek bir `inFlight` çalışmasını paylaşır.
- Upstash etkinse tüm Vercel instance’ları `SET NX PX` distributed lock ile tek tick’e indirilir.
- Son 10.000 rapor saklanır; sinyalin 4–10 dakika sonraki getirisi iki maker ücreti düşülerek ölçülür.
- Kalibrasyon örneği azsa size otomatik %70’e iner ve edge eşiğine 10 bps eklenir. Kötü fee-sonrası performans size’ı azaltıp eşiği yükseltir; hiçbir zaman hard risk limitini büyütmez.
- Her tur aktif emirlerle uzlaştırılır; stale/değişmiş emir iptal edilmeden yenisi açılmaz.
- `STOP_AFTER_ROUND_NUMBER` terminal duruma geldiğinde açık emirler önce iptal edilir. İptallerin tamamı doğrulanırsa cron job otomatik kapanır; hata varsa güvenli kontrol devam eder.
- GitHub Actions yalnızca elle çalıştırılan yedektir. İki scheduler’ı aynı anda kullanmayın.

Bu model 7/24 dakikalık heartbeat sağlar; 5 saniyelik HFT değildir. Sürekli WebSocket gerekiyorsa Vercel Hobby yerine kalıcı container/VPS gerekir.

Kaynaklar: [League](https://beta.loafmarkets.com/league), [Learn](https://beta.loafmarkets.com/learn), [Loaf bot rehberi](https://docs.loafmarkets.com/en/guides/building-a-trading-bot/), [Orders API](https://docs.loafmarkets.com/en/api-reference/orders/), [Trade API](https://docs.loafmarkets.com/en/api-reference/trade/), [cron-job.org REST API](https://docs.cron-job.org/rest-api.html), [Vercel cron limitleri](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Upstash REST API](https://upstash.com/docs/redis/features/restapi), [Upstash Redis fiyat/ücretsiz kota](https://upstash.com/pricing/redis).

## Önce güvenlik

Sohbette paylaşılan Loaf API key artık gizli kabul edilemez. Loaf ayarlarından **hemen revoke edin ve yeni key üretin**. Paylaşılan key bu projeye yazılmadı ve kullanılmadı.

- `LOAF_API_KEY` ve `CRONJOB_API_KEY` yalnızca Vercel Production Environment Variables içinde tutulur.
- cron-job.org job’ında yalnızca ayrı `CRON_SECRET` bulunur; Loaf key hiçbir zaman scheduler’a verilmez.
- `CRON_SECRET`, Loaf ve cron-job.org anahtarlarından farklı, en az 32 rastgele karakter olmalıdır.
- Preview deploy’a production key vermeyin. `.env*` git tarafından ignore edilir.
- `/api/tick`, `/api/status`, `/api/emergency-stop` ve `/api/scheduler` Bearer secret ile korunur.

## Lokal doğrulama

```bash
npm install
npm run check
```

Read-only Loaf hesap/API preflight’i (emir göndermez):

```powershell
$env:LOAF_API_KEY="<LOAF_API_KEY>"
npm run preflight
Remove-Item Env:LOAF_API_KEY
```

## Vercel + Upstash + cron-job.org kurulumu

1. Bu repoyu GitHub’a push edip Vercel’e import edin.
2. Upstash’te ücretsiz Redis database oluşturun ve REST URL/token değerlerini alın.
3. [cron-job.org](https://cron-job.org/) hesabı açın; Console → Settings altında API key üretin.
4. Vercel Project Settings → Environment Variables → **Production** alanına ilk deploy öncesi şunları ekleyin:

```text
LOAF_API_KEY=<rotate-edilmiş-yeni-64-hex-key>
CRON_SECRET=<en-az-32-karakter-rastgele-secret>
BOT_PUBLIC_URL=https://projeniz.vercel.app
CRONJOB_API_KEY=<cron-job.org-api-key>
STOP_AFTER_ROUND_NUMBER=<yarışmanın-final-round-numarası>
UPSTASH_REDIS_REST_URL=<upstash-rest-url>
UPSTASH_REDIS_REST_TOKEN=<upstash-rest-token>
REQUIRE_DURABLE_LOCK=true
STATE_NAMESPACE=loaf:league:trader
TELEMETRY_MAX_RUNS=10000
TRADING_ENABLED=false
ALLOW_OUTSIDE_COMPETITION=false
KILL_SWITCH=false
LOAF_HANDLE=<leaderboard-handle-veya-boş>
LOAF_WALLET_ADDRESS=<leaderboard-wallet-veya-boş>
```

5. Production deploy yapın.
6. Korumalı kurulum endpointini yalnızca bir kez çağırın:

```powershell
$botHeaders = @{ Authorization = "Bearer <CRON_SECRET>" }
Invoke-RestMethod -Method Post -Uri "https://projeniz.vercel.app/api/scheduler" -Headers $botHeaders
```

7. Dönen `jobId` değerini Vercel’e `CRONJOB_JOB_ID=<jobId>` olarak ekleyin ve yeniden deploy edin. Bu ikinci deploy yarışma sonu otomatik kapatma için zorunludur.
8. cron-job.org Console’da job’ın etkin, `POST`, her dakika ve son durumunun HTTP 200 olduğunu doğrulayın.
9. `/api/status` çıktısında `durableStateConfigured=true`, `durableLockRequired=true` ve `schedulerConfigured=true` doğrulayın.
10. Admission sonrası leaderboard satırınızın handle veya wallet değerini girin; aksi hâlde bot `balanced` modda kalır.
11. `TRADING_ENABLED=false` ile en az bir aktif tur dry-run gözlemi yapmadan live moda geçmeyin.

Scheduler ayarlarını güvenli biçimde tekrar senkronize etmek için aynı `POST /api/scheduler` çağrısını kullanabilirsiniz; aynı isim/id ile job güncellenir, çoğaltılmaz. Elle kapatmak için:

```powershell
Invoke-RestMethod -Method Delete -Uri "https://projeniz.vercel.app/api/scheduler" -Headers $botHeaders
```

## Kontrol ve acil durdurma

```powershell
$botHeaders = @{ Authorization = "Bearer <CRON_SECRET>" }
Invoke-RestMethod -Uri "https://projeniz.vercel.app/api/status" -Headers $botHeaders
Invoke-RestMethod -Method Post -Uri "https://projeniz.vercel.app/api/emergency-stop" -Headers $botHeaders
```

Kalibrasyon ve son tick raporları:

```powershell
Invoke-RestMethod -Uri "https://projeniz.vercel.app/api/telemetry?limit=120" -Headers $botHeaders
```

Son 5.000 tick üzerinde fee-sonrası replay:

```powershell
$env:BOT_PUBLIC_URL="https://projeniz.vercel.app"
$env:CRON_SECRET="<CRON_SECRET>"
npm run replay
```

`/api/emergency-stop`, `TRADING_ENABLED` değerinden bağımsız biçimde tüm açık emirleri iptal etmeyi dener. Kalıcı durdurma için ayrıca `KILL_SWITCH=true`, `TRADING_ENABLED=false` yapın ve `/api/scheduler` için `DELETE` çağırın.

## Canlıya alma kapıları

1. **Observation:** Aktif tur başlamadan `TRADING_ENABLED=false`; status, fee ve public market şemaları doğrulanır.
2. **Competition dry-run:** Aktif turda en az 24 saat `competition.admitted=true`, taze candle, doğru fee ve mantıklı desired orders görülür.
3. **Micro-live:** `ORDER_NOTIONAL_PCT=0.25`, `MAX_MARKETS_PER_TICK=1`, `MAX_GROSS_EXPOSURE_PCT=10`, `CASH_RESERVE_PCT=60` ile başlanır.
4. **Scale:** En az 20 fill/24 saat boyunca fee-sonrası PnL, adverse selection, reject ve cancel oranı kabul edilebilirse limitler kademeli büyütülür.

## Strateji ve risk

- Fair value; mid, microprice, book imbalance, EMA momentumu ve sınırlı mean reversion birleşimidir.
- Yönlü girişlerde 5 dakikalık sinyal, 15 dakikalık trend yönüyle doğrulanır.
- Maker quote ancak görünen spread maker ücretlerini ve minimum edge’i karşılıyorsa açılır.
- Yönlü quote giriş ve çıkış için iki maker ücreti + minimum edge + adaptif güvenlik payını karşılamalıdır.
- Sizing volatiliteyle ters, yalnızca açıkça yayınlanan multiplier ile doğru orantılı ve yakın bid likiditesinin en fazla %15’iyle sınırlıdır.
- Kalibrasyon 15–45 dakikalık ücret-sonrası sonucu öğrenir; ciddi negatif edge üreten market yeni envantere karantinaya alınır fakat gözlemlenmeye devam eder.
- Stop-loss ve take-profit 5 dakikalık volatiliteye göre dinamikleşir; tur içi portföy zirvesinden drawdown da kalıcı state ile korunur.
- Leaderboard’da ilk %35 `preserve`, orta bölüm `balanced/defend`, alt %30 `attack` kullanır; hard exposure/drawdown limitleri hiçbir modda aşılmaz.
- Stop-loss, stale candle, bozuk/tek taraflı book, anormal tek-bar hareket, aşırı spread ve drawdown devre kesicileri vardır.
- Wash trading, self-trade veya skor manipülasyonu uygulanmaz.

## Önemli değişkenler

Tam liste [.env.example](./.env.example) içindedir.

| Değişken | Varsayılan | Etki |
|---|---:|---|
| `TRADING_ENABLED` | `false` | `false` iken hiçbir trade write göndermez |
| `LOAF_HANDLE` / `LOAF_WALLET_ADDRESS` | boş | Kendi rank’ınızı bularak preserve/defend/attack seçer |
| `ALLOW_OUTSIDE_COMPETITION` | `false` | Aktif tur dışında yeni emir üretimini engeller |
| `STOP_AFTER_ROUND_NUMBER` | boş | Terminal round sonrası cleanup + scheduler stop |
| `REQUIRE_DURABLE_LOCK` | `false` | Live için `true`; Redis yoksa tick’i fail-closed durdurur |
| `TELEMETRY_MAX_RUNS` | `10000` | Redis’te tutulan replay penceresi |
| `MAX_DRAWDOWN_PCT` | `6` | Başlangıç/round peak referanslı cancel-all devre kesici |
| `MAX_GROSS_EXPOSURE_PCT` | `60` | Toplam long notional tavanı |
| `MAX_MARKET_EXPOSURE_PCT` | `12` | Tek piyasa tavanı |
| `CASH_RESERVE_PCT` | `25` | Kullanılmayan nakit tamponu |
| `ORDER_NOTIONAL_PCT` | `2` | Baz emir büyüklüğü; volatilite/kalibrasyon/likidite ile aşağı ölçeklenir |
| `MIN_STOP_LOSS_PCT` / `STOP_LOSS_PCT` | `1.5` / `4` | Volatiliteye bağlı stop alt/üst sınırı |
| `MIN_TAKE_PROFIT_PCT` / `MAX_TAKE_PROFIT_PCT` | `1.5` / `4` | Ücret ve volatiliteye bağlı kâr alma bandı |
| `QUOTE_TTL_SECONDS` | `240` | Emir yenileme yaş sınırı |
| `MIN_NET_EDGE_BPS` | `30` | Ücret üstü minimum edge |
| `MAX_SPREAD_BPS` | `120` | Anormal geniş spread devre kesicisi |
| `LIQUIDITY_DEPTH_BPS` / `MAX_BOOK_PARTICIPATION_PCT` | `25` / `15` | Çıkış book derinliği ve katılım limiti |

## Operasyonel sınırlar

- Harici scheduler ve internet servisleri yüzde 100 uptime garantisi vermez; cron-job.org failure e-postalarını açın ve günlük kontrol edin.
- Dakikalık çağrı ayda yaklaşık 43.200 invocation üretir; güncel Vercel kullanımınızı dashboard’dan izleyin. Sağlayıcı limitleri değişebilir.
- Upstash distributed lock overlap’i engeller; yine de ağ seviyesinde tam exactly-once execution garantisi yoktur. Tek scheduler kullanın ve active-order reconciliation’ı kapatmayın.
- Upstash yapılandırılmadığında yalnızca instance-içi lock vardır; live moda geçmeyin. Upstash ücretsiz kotası güncel olarak 500 bin komut/aydır; dakikalık bot yaklaşık 300 bin komut/ay kullanır, dashboard kotasını izleyin.
- Yarışma kuralları her tur değişebilir. `roundRules`, fee ve multiplier değerlerini her tur başında kontrol edin.

Ayrıntılı işletim adımları [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md), olay müdahalesi [SECURITY.md](./SECURITY.md) içindedir.

Son doğrulama sonuçları ve live öncesi açık kapılar [TEST_REPORT.md](./TEST_REPORT.md) içindedir.
