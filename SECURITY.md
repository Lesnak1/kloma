# Security policy

## Secret yönetimi

- `LOAF_API_KEY`, `CRONJOB_API_KEY` ve `UPSTASH_REDIS_REST_TOKEN` yalnızca Vercel Production Environment Variables içinde bulunur.
- cron-job.org job’ına sadece `/api/tick` için kullanılan ayrı `CRON_SECRET` verilir.
- `CRON_SECRET` en az 32 rastgele karakterdir; diğer iki API key ile aynı değildir.
- Preview deploy’da live key kullanılmaz; log, issue, commit, screenshot veya chat’e secret yazılmaz.
- `.env*` dosyaları ignore edilir. Vercel deploy ve GitHub secret scanning açık tutulur.
- cron-job.org API key hesap düzeyinde job yönetebilir; sağlayıcının önerdiği IP kısıtlaması Vercel’in çıkış IP modeli uygunsa etkinleştirilir.

## Paylaşılan Loaf key için olay müdahalesi

1. Loaf web uygulamasından paylaşılan key derhal revoke edilir.
2. Yeni key yalnızca Vercel Production environment’a eklenir.
3. Açık emirler UI veya yeni key ile `/api/emergency-stop` üzerinden kontrol edilir.
4. Git history `git log -S` ve repository secret scanning ile taranır.
5. Vercel, cron-job.org ve Loaf loglarında beklenmeyen çağrılar incelenir.

## Endpoint modeli

- `/api/tick`: Bearer secret; dry-run/live trade turu.
- `/api/status`: Bearer secret; private portfolio ve yarışma özeti.
- `/api/emergency-stop`: Bearer secret; tüm açık emirleri iptal eder.
- `/api/scheduler`: Bearer secret; cron-job.org job oluşturur/günceller veya kapatır.
- `/api/telemetry`: Bearer secret; saklanan run raporlarını ve kalibrasyon state’ini okur.

Scheduler `saveResponses=false` kullanır ve compact cevap ister. Buna rağmen `CRON_SECRET` cron-job.org hesap ayarındaki job header’ında tutulur; cron-job.org hesabı ele geçirilirse secret rotate edilmelidir. Loaf key scheduler’a hiç verilmez.

## Acil durdurma

1. `POST /api/emergency-stop` çağırın; `failedOrders=[]` doğrulayın.
2. `DELETE /api/scheduler` çağırın.
3. Vercel’de `KILL_SWITCH=true`, `TRADING_ENABLED=false` yapıp redeploy edin.
4. İlgili Loaf/cron-job.org/cron secret’larını rotate edin.
5. Active orders ve portfolio durumunu bağımsız olarak Loaf UI’da doğrulayın.
