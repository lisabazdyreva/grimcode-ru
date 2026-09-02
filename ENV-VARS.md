# Переменные окружения: откуда берутся и где используются

Разбор одной темы целиком: как значение из `.env` доходит до места, где оно на что-то влияет. Все
чтения найдены грепом по коду, ссылки ведут на строки.

Спутник `MODULE-CALLS.md`, где разобрано, как модули зовут друг друга.

---

## 1. Как значения попадают в процесс

Файл `.env` читает **Node, а не наш код** — [package.json:23](package.json:23):

```json
"dev": "pnpm run build && node --env-file=.env dist/index.js"
```

Флаг `--env-file` кладёт строки файла в `process.env`. Библиотеки для этого в проекте нет.

На платформе развёртывания файла нет вовсе: переменные задаёт платформа, и `PORT` обычно именно так.

---

## 2. Кто имеет право читать

**Читают два места, и всё.**

`shared/src/env.ts` — три функции, только они трогают `process.env`:

```ts
optionalEnv(name, fallback)   // нет значения — берём запасное
requireEnv(name)              // нет значения — отказ со внятным текстом
intEnv(name, fallback)        // то же, но число; не число — отказ
```

Корневой `index.ts` — единственный, кто зовёт их по именам переменных.

### Модулям запрещено

Два запрета в [eslint.config.js:69](eslint.config.js:69): слово `process` в любой форме и импорт
`optionalEnv`, `requireEnv`, `intEnv` из `shared`.

Второй запрет появился потому, что первый обходился: модуль просил `shared` прочитать переменную за
него — тогда чтение происходит в `shared`, а модуль только передаёт строку. Измерено:
`optionalEnv('DATABASE_URL', '')` внутри модуля проходил `check-boundaries` с кодом 0.

**Проверено зондом.** Здоровый файл в модуле — код 0, молчит. Тот же файл с тремя запрещёнными
способами — код 1 и четыре ошибки:

```
1:10  'optionalEnv' import from '@template/shared' is restricted…   no-restricted-imports
4:13  Unexpected use of 'process'…                                  no-restricted-globals
4:13  A module does not touch process, by any route…                no-restricted-syntax
5:30  A module does not touch process, by any route…                no-restricted-syntax
```

Строка 5 — это `const { env } = globalThis.process`. Её `no-restricted-globals` не видит: там
`process` не глобальная ссылка, а свойство. Поймало второе правило — ради этого случая оно и стоит.

### Одна законная дорога в модуль всё-таки есть

Три функции `shared` модулям разрешены: `publicSiteUrl()`, `sessionCookieName()`, `csrfCookieName()`.
Внутри они читают `process.env`, но переменную несут в себе — модуль, держащий такую функцию, ничего
другого ею не достанет. Довод записан в [eslint.config.js:61](eslint.config.js:61).

Значит значения приезжают в модуль **двумя путями**: настройки — от точки сборки, на `c.env`; слаг и
адрес сайта — вызовом функции из `shared`.

---

## 3. Каждая переменная до места использования

### `PROJECT_SLUG` — техническое имя проекта

**Читается** в [env.ts:41](shared/src/env.ts:41) через `requireEnv` — то есть обязательна.

**Три применения.**

**Имена баз** — [index.ts:259](index.ts:259):

```ts
return Buffer.from(`${projectSlug()}_${module}`, 'utf8').subarray(0, IDENTIFIER_LIMIT)…
```

Отсюда `template_auth`, `template_users` и остальные. Обрезка до 63 байт — потому что PostgreSQL режет
имена молча; если после обрезки два имени совпадут, программа откажется стартовать
(`assertDistinctDatabases`).

**Имя куки сессии** — [env.ts:49](shared/src/env.ts:49): `` `${projectSlug()}_session` ``. Поэтому две
копии проекта на одной машине не выбивают друг друга из сессии.

**Имена кук CSRF** — [env.ts:58](shared/src/env.ts:58): `` `${projectSlug()}_csrf_${scope}` ``, своя на
каждую админскую поверхность. Их пять: `panel`, `auth`, `users`, `notifications`, `email`. Одно имя на
всех означало бы, что кто последний спросил токен — тот перезатёр остальным, и первая при следующем
изменении получила бы отказ без объяснения причины.

При слаге `grimcode_monolith` куки этого worktree называются `grimcode_monolith_session`,
`grimcode_monolith_csrf_panel` и так далее.

**Где доходит до модуля:** имена баз приезжают значениями на `c.env`, а имя куки модуль спрашивает
сам — [auth/src/routers/public.ts:61](modules/auth/src/routers/public.ts:61),
[gateway/src/authorize.ts:19](modules/gateway/src/authorize.ts:19),
[users/src/auth-client.ts:15](modules/users/src/auth-client.ts:15),
[admin/src/routers.ts:334](modules/admin/src/routers.ts:334).

**Почему обязательна.** Измерено 27 августа: запуск без слага отвечал 200 и создавал базы
`template_auth`, `template_email`, `template_notifications` — данные уезжали туда, куда никто не просил.

### `PUBLIC_SITE_URL` — внешний адрес проекта

**Читается** в [env.ts:45](shared/src/env.ts:45), обязательна:

```ts
return requireEnv('PUBLIC_SITE_URL').replace(/\/+$/, '');
```

Регулярка срезает косые черты в конце строки. Зачем: адреса дальше собираются склейкой, и написанное в
`.env` значение `http://127.0.0.1:63000/` дало бы ссылку `http://127.0.0.1:63000//app/verify-email`.
Формально рабочую, но выглядящую поломкой. Дешевле срезать один раз при чтении, чем помнить об этом в
пяти местах склейки.

**Четыре применения:**

1. **сайту** — [index.ts:88](index.ts:88): `createSiteApp({ origin: publicSiteUrl() })`;
2. **ссылки в письмах** — [public.ts:72](modules/auth/src/routers/public.ts:72):
   ```ts
   return `${publicSiteUrl()}/app/${path}?token=${encodeURIComponent(token)}`;
   ```
   Подтверждение адреса и сброс пароля. Те же ссылки из админской поверхности —
   [admin.ts:138](modules/auth/src/routers/admin.ts:138) и
   [:175](modules/auth/src/routers/admin.ts:175);
3. **флаг `Secure` у куки** — [cookies.ts:51](shared/src/http/cookies.ts:51): куку помечают «только по
   https», если адрес начинается на `https://`. Не через `NODE_ENV`, и это осознанно: та же сборка
   локально работает по обычному http, и `Secure`-кука там просто не вернулась бы;
4. **страница отказа шлюза** — [responses.ts:63](modules/gateway/src/responses.ts:63): ссылка «войти».

**Почему обязательна.** Забытый адрес тише слага и потому опаснее: письма уходят рабочие, но со
ссылками на `127.0.0.1`, а кука на https-развёртывании теряет `Secure`.

### `PORT` и `GATEWAY_PORT` — на чём слушать

**Читаются** в [index.ts:274](index.ts:274), по порядку:

```ts
for (const name of ['PORT', 'GATEWAY_PORT']) {
  const port = intEnv(name, 0);
  if (port !== 0) return port;
}
throw new Error('Neither PORT nor GATEWAY_PORT is set, …');
```

`PORT` первым — его задаёт платформа развёртывания. `GATEWAY_PORT` из `.env` — то, что позволяет двум
worktree работать одновременно.

**Используется в одном месте** — [index.ts:294](index.ts:294), `serve(...)`. До модулей не доходит
вовсе: порт открывает программа, модулям он не нужен и не выдаётся.

**Умолчания нет намеренно.** Было — 8080, и срабатывало только когда `.env` пустой или отсутствует, то
есть ровно в том случае, когда процесс поднимался бы на порту, куда никто не маршрутизирует: здоровый
на вид и бесполезный.

### `DATABASE_URL` — адрес сервера базы

**Читается** дважды — [index.ts:236](index.ts:236) и [index.ts:251](index.ts:251), обе через
`requireEnv`.

Это единственная переменная, которую точка сборки **разбирает и пересобирает**, а не передаёт как есть.
Из неё делаются три строки на каждый модуль с базой — [index.ts:194](index.ts:194):

```ts
export function databaseEnv(module: DatabaseModule): ModuleDatabase {
  return {
    databaseUrl: serviceDatabaseUrl(module),        // тот же сервер, имя базы подменено на <слаг>_<модуль>
    databaseName: serviceDatabaseName(module),      // просто имя, для сверки
    maintenanceUrl: maintenanceDatabaseUrl(module), // сервер сам, для одного CREATE DATABASE
  };
}
```

Зачем `databaseName` отдельной строкой, если он есть внутри `databaseUrl`: чтобы сверка сравнивала
выданное с открывшимся, а не строку с самой собой.

#### Как эти три строки доходят до `db/database.ts`

Четыре передачи подряд, и первая — та, которую труднее всего заметить.

**1. Второй аргумент `fetch`** — [index.ts:86](index.ts:86):

```ts
const call = (name) => (request) => apps[name].fetch(request, envByModule[name]);
```

Обычно `fetch` вызывают с одним аргументом. Hono разрешает второй, и то, что в него передали,
становится `c.env` внутри модуля. **Это единственная дорога окружения в модуль.**

**2. Из `c.env` в сборку контекста** — [auth/src/index.ts:71](modules/auth/src/index.ts:71):

```ts
repo: await repository(hono.env),
```

**3. `repository` передаёт его дальше** — [auth/src/index.ts:48](modules/auth/src/index.ts:48):

```ts
const database = createDatabase();
const repository = async (env: AuthEnv) => new AuthRepository(await database(env));
```

**4. И здесь используются все три строки** — [db/database.ts:17](modules/auth/src/db/database.ts:17):

```ts
export function createDatabase(): (env: AuthEnv) => Promise<Pool> {
  const open = async (env: AuthEnv): Promise<Pool> => {
    await ensureDatabase(env);                            // ← maintenanceUrl и databaseName
    const pool = new pg.Pool({
      connectionString: env.databaseUrl,                  // ← databaseUrl, строка 22
      max: MAX_CONNECTIONS,
      …
    });
    await assertOpenedDatabase(pool, env.databaseName);   // ← databaseName, строка 34
    await runMigrations(pool, migrations);
```

А `maintenanceUrl` — внутри `ensureDatabase`,
[db/database.ts:67](modules/auth/src/db/database.ts:67):

```ts
const server = new pg.Pool({ connectionString: env.maintenanceUrl, max: 1, … });
await waitForDatabase(server);
const { rowCount } = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [env.databaseName]);
if (rowCount) return;
await server.query(`CREATE DATABASE "${env.databaseName.replace(/"/g, '""')}"`);
```

Итого: `maintenanceUrl` — второе, короткоживущее соединение к серверу, только чтобы создать базу
(изнутри себя база не создаётся). `databaseUrl` — своя база. `databaseName` — для сверки и для команды
создания.

**Почему `env` едет аргументом до самого низа, а не лежит в переменной модуля:** `c.env` существует
только внутри запроса. Поэтому пул создаётся на первом запросе, а не при сборке программы.

### `DATABASE_URL_<МОДУЛЬ>` — база модуля на другом сервере

**Читается** в [index.ts:233](index.ts:233), необязательная:

```ts
const override = optionalEnv(`DATABASE_URL_${module.toUpperCase()}`, '');
if (override !== '') return override;
```

Имя переменной **складывается на ходу** — то есть грепом по коду вы её не найдёте. Их пять возможных:
`DATABASE_URL_AUTH`, `_USERS`, `_ADMIN`, `_EMAIL`, `_NOTIFICATIONS`.

**Ловушка, измеренная 26 августа:** менять этой переменной можно **сервер, а не имя базы**. Имя всё
равно считается из слага, поэтому при `DATABASE_URL_CATALOG=…/probe_env_goods` модуль создал
`probe_env_catalog`, подключился к `probe_env_goods` и ответил 500 текстом драйвера. Правило «имя
обязано быть `<слаг>_<модуль>`» в сообщении не названо.

В `.env.example` её нет, живьём ею не пользовались ни разу. Она же — причина, по которой
`maintenanceDatabaseUrl` выводится из строки модуля, а не из `DATABASE_URL`
([index.ts:243](index.ts:243)): модуль, отправленный на другой сервер, и базу должен создать **там**.

### `AUTH_SESSION_TTL_SECONDS` — сколько живёт сессия

**Читается** в [index.ts:209](index.ts:209), с умолчанием 30 суток:

```ts
sessionTtlSeconds: intEnv('AUTH_SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),
```

**Доезжает** в `authEnv` ([index.ts:62](index.ts:62)) и дальше в контекст процедур — но не целиком: в
[public.ts:30](modules/auth/src/routers/public.ts:30) объявлено
`env: Pick<AuthEnv, 'sessionTtlSeconds'>`. Процедурам дают одно это поле, а строку подключения рядом —
нет, она им не нужна.

**Используется** при открытии сессии — [public.ts:77](modules/auth/src/routers/public.ts:77):

```ts
const ttl = ctx.env.sessionTtlSeconds;
await ctx.repo.createSession(identityId, token, ttl, …);
ctx.resHeaders.append('set-cookie', sessionCookie(token, ttl));
```

Одно значение в двух местах сразу: срок строки в базе и `Max-Age` куки. Иначе кука жила бы дольше
сессии или наоборот.

**Умолчание здесь есть**, и это решение про установку, а не про запуск: без него программа не
поднялась бы, а тридцать суток не создают тихой поломки. А лимиты входа рядом умышленно оставлены
константами в коде — их форма решение проекта, не установки.

### Пять почтовых переменных

**Читаются вместе** — [index.ts:219](index.ts:219):

```ts
return {
  provider:    optionalEnv('EMAIL_PROVIDER', ''),
  apiKey:      optionalEnv('UNISENDER_GO_API_KEY', ''),
  apiUrl:      optionalEnv('UNISENDER_GO_API_URL', ''),
  fromAddress: optionalEnv('EMAIL_FROM_ADDRESS', ''),
  fromName:    optionalEnv('EMAIL_FROM_NAME', ''),
};
```

Все пять пересылаются **как написано, без разбора**. Довод в комментарии рядом: что значит пустое
значение — дело модуля. Решай это точка сборки, и `EMAIL_PROVIDER` с опечаткой стал бы её решением не
отправлять людям письма.

**Доезжают** одним полем `mail` в `emailEnv` ([index.ts:63](index.ts:63)) и превращаются в транспорт —
[email/src/index.ts:40](modules/email/src/index.ts:40):

```ts
const transport = (env: EmailEnv) => (built ??= createTransport(env.mail));
```

Строится один раз и запоминается: провайдер за время работы процесса не меняется.

**Где каждая срабатывает:**

- **`EMAIL_PROVIDER`** — единственная развилка,
  [transport.ts:154](modules/email/src/transport.ts:154):
  ```ts
  return settings.provider === 'unisender' ? createUniSenderTransport(…) : createLogTransport();
  ```
  Всё, кроме слова `unisender`, значит «локально»;
- **`UNISENDER_GO_API_KEY`** и **`EMAIL_FROM_ADDRESS`** — несущие,
  [transport.ts:98](modules/email/src/transport.ts:98): без них транспорт отказывает, **называя имена
  переменных**. Комментарий рядом объясняет странность: модуль этих имён не читает, но просит-то он
  правку окружения, а там имена именно такие;
- **`EMAIL_FROM_NAME`** — имя отправителя в ящике получателя;
- **`UNISENDER_GO_API_URL`** — [transport.ts:94](modules/email/src/transport.ts:94): пустая значит
  «взять адрес из константы». Не задаёт её никто, в `.env.example` её нет. Оставлена решением владельца
  19 августа — в `main` она была такой же.

### `SCHEMA_SOURCE_ROOT` — куда писать миграцию из раздела базы

**Читается** в [index.ts:106](index.ts:106):

```ts
const writer = createMigrationWriter(
  optionalEnv('SCHEMA_SOURCE_ROOT', '') || findProjectRoot(),
  new Map(DATABASE_MODULES.map((module) => [serviceDatabaseName(module), module])),
);
```

Пусто — пишем в исходники этого проекта, найденные обходом дерева вверх. Задана — пишем туда.

**До модуля не доходит вовсе.** Достаётся разделу базы ([index.ts:110](index.ts:110)) как способ
записать файл, вместе с картой «имя базы → какой это модуль», чтобы миграция легла в папку своего
модуля.

Нужна копиям под браузерные проверки: две из них правда добавляют и удаляют колонки, а это теперь
запись файла в исходники. Без отведённого места каждый прогон оставлял бы в репозитории по два файла,
и молча.

---

## 4. Что читает не программа

Эти переменные видно в окружении, и это сбивает: программа их не читает.

**`PORT_RANGE_START` и `PORT_RANGE_END`** — только скрипт
[bootstrap-worktree.mjs:201](scripts/bootstrap-worktree.mjs:201), и то из файла `.env`, который он
разбирает сам, а не из `process.env`. Нужны, чтобы выдать новому worktree свободный порт.

**`ACCEPTANCE_BASE_URL`, `ACCEPTANCE_OWNER_EMAIL`, `ACCEPTANCE_OWNER_PASSWORD`** — только наборы
проверок ([tests/src/client.ts:9](tests/src/client.ts:9),
[tests/src/fixtures.ts:54](tests/src/fixtures.ts:54)). В `.env.example` их нет.

**`NODE_ENV` в нашем коде не читает никто** — проверено грепом. В `turbo.json` она перечислена в
`globalEnv`, то есть влияет на кэш задач сборки, но не на поведение программы. В комментарии
[cookies.ts:46](shared/src/http/cookies.ts:46) это сказано прямо: `Secure` следует за адресом сайта, а
не за `NODE_ENV`.

---

## 5. Что лежит в `.env.example`

Одиннадцать имён, посчитано: `PROJECT_SLUG`, `PORT_RANGE_START`, `PORT_RANGE_END`, `PUBLIC_SITE_URL`,
`GATEWAY_PORT`, `DATABASE_URL`, `AUTH_SESSION_TTL_SECONDS`, `EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`,
`EMAIL_FROM_NAME`, `UNISENDER_GO_API_KEY`.

Лишнего в примере нет ни одного. А вне его читаются ещё четыре вида: `SCHEMA_SOURCE_ROOT`, три
`ACCEPTANCE_*`, `PORT` и пять `DATABASE_URL_<МОДУЛЬ>`. Решением владельца 31 августа пример не
правится: «нужных для работы» эти четыре не являются.

---

## 6. Два правила, которые легко нарушить

**Новая переменная обязана попасть в `globalEnv` в `turbo.json`.** Сейчас там пять имён: `NODE_ENV`,
`PROJECT_SLUG`, `PUBLIC_SITE_URL`, `DATABASE_URL`, `EMAIL_PROVIDER`. Измерено 26 августа: смена
`EMAIL_PROVIDER` меняет хэш задачи `test`, а смена `EMAIL_FROM_NAME` (её в списке нет) — нет. То есть
без строки в списке turbo отдаст результат, посчитанный при прошлом значении. Родня приметам про
`eslint.config.js` в `globalDependencies` и `web/dist` в `outputs`: тот же класс «зелено, потому что не
запускалось».

**Окружение читается один раз, но не всё.** `compose()` вызывает `mailSettings()`, `authSettings()` и
`databaseEnv()` на старте и держит значения в замыкании. А `publicSiteUrl()` и `sessionCookieName()`
модули зовут **на каждом запросе** — эти две читают `process.env` заново каждый раз.

---

## 7. Открытый вопрос

**Удалять ли `DATABASE_URL_<МОДУЛЬ>`.** Обсуждалось 1 сентября, решения нет.

За удаление: переменной никогда не пользовались, в примере её нет, а её отказ не объясняет правила
(«имя обязано быть `<слаг>_<модуль>`» в тексте 500 не названо).

Против: две строки кода дают возможность увести базу одного модуля на другой сервер — запас на случай,
когда одной базе станет тесно. К отказу от выноса модулей в сервисы это отношения не имеет: базы
отдельный вопрос.

Если удалять, тронуть придётся: три строки в `serviceDatabaseUrl`; `maintenanceDatabaseUrl`, который
выводится из строки модуля именно ради этой переменной; три теста в `index.test.ts` (строки 119, 131,
157); шесть мест в документации (`docs/architecture.md` дважды, `docs/local-development.md` трижды,
`docs/composer.md`); комментарии в шести файлах — пять `db/database.ts` и `auth.test.ts` объясняют
через эту переменную, зачем нужна сверка открытой базы. Сама сверка нужна независимо: она ловит и
обычную опечатку в `DATABASE_URL`.
