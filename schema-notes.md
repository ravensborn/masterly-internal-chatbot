# Curated schema notes — Masterly LMS

Hand-written companion to the generated schema. Everything here is what
introspection can't tell you: translated columns, enum values, polymorphic
relations, and the traps that produce silently-wrong answers.

## Translatable (JSON) columns

Many text columns are spatie/laravel-translatable maps, not plain strings. The
locale keys in this database are **`en`, `ku`, `ku-b`, `ar`** (`ku` = Sorani
Kurdish, `ku-b` = Badini Kurdish). Not every key is present on every row.

Affected columns: `courses.title`, `courses.description`, `bundles.name`,
`bundles.description`, `categories.name`, `cities.name`, `lessons.title`,
`lessons.description`, `lesson_groups.title`, `quizzes.title`,
`quizzes.description`, `instructors.display_name`, `instructors.about`,
`tags.name`, `tags.slug`, `textual_resources.content`.

```sql
-- read one locale
SELECT title->>'en' AS title_en FROM courses;

-- search across every locale (the ::text cast searches the raw JSON)
SELECT id, title->>'en' FROM courses WHERE title::text ILIKE '%math%';
```

`WHERE title = 'Mathematics'` never matches — the stored value is a JSON object.
Other JSON columns are *not* translations and have their own shapes:
`users.preferences` (feature flags), `instructors.socials`,
`payments.gateway_response` (raw gateway payload), `notifications.data`,
`quiz_attempts.question_ids` (array), `chat_attachments.meta`.

## Domain map

**People.** `users` is the single account table with a `type` discriminator
(`learner`, `instructor`, `admin`) plus one profile row per type in `learners`,
`instructors`, or `admins` (each has `user_id`). A learner's name and email live
on `users`; their city/gender/birthday live on `learners`. Almost every
learner-scoped table references `learners.id`, **not** `users.id` — mixing the
two is the most common source of wrong counts. The exceptions that reference
`users.id` directly are `ratings`, `favorites`, `conversations`, `messages`,
and `sessions`.

**Catalog.** `categories` (self-referencing via `parent_id`) → `courses`
(`category_id`, `instructor_id`) → `lesson_groups` → `lessons` → `videos`
(Cloudflare Stream; `lessons.stream_uid`/`stream_status`). `bundles` group
courses through the `bundle_course` pivot. `resources` and `textual_resources`
hold attachments; `interactions` are in-video questions on a lesson, answered
in `learner_interactions` / `learner_interaction_options`.

**Commerce.** `orders` (one per checkout, `learner_id` + *either* `course_id` or
`bundle_id`) → `payments` (gateway attempts against `order_id`) → `enrollments`
(`learner_id` + `course_id`, optional `order_id`/`bundle_id`, optional
`expires_at`). A bundle order fans out into one enrollment per course in the
bundle, which is why enrollments can outnumber their order.

**Learning activity.** `lesson_watches` (per learner + lesson),
`quizzes` → `questions` → `question_options`, attempts in `quiz_attempts` →
`quiz_attempt_answers` → `quiz_attempt_answer_options`.

**Everything else.** `ratings` and `favorites` (polymorphic, see below),
`tags`/`taggables`, support chat in `conversations` → `messages` →
`chat_attachments`, plus `notifications` and `app_versions`.

## Enum values (read from the data, not from code)

| Column | Values |
| --- | --- |
| `users.type` | `learner`, `instructor`, `admin` |
| `users.provider` | `google`, `apple`, NULL (email/password) |
| `users.language` | `en`, `ku`, `ku-b`, `ar` |
| `orders.status` | `pending`, `paid`, `failed`, `cancelled` |
| `payments.payment_method` | `fib`, `fastpay` (the two Iraqi gateways) |
| `payments.gateway_status` | `PAID`, `DECLINED`, `UNPAID`, `Success` |
| `conversations.status` | `pending`, `resolved` |
| `messages.type` | `text`, `image` |
| `lessons.stream_status` | `pending`, `ready` |
| `questions.type` / `interactions.type` | `single-choice` |
| `notifications.type` | `course`, `chat_message` |
| `tags.type` | `preference` |
| `app_versions.platform` | `ios`, `android` |

**`payments.gateway_status` is not normalised.** Successful payments appear as
both `PAID` (FIB) and `Success` (FastPay), and the casing is inconsistent —
match with `gateway_status ILIKE 'paid' OR gateway_status ILIKE 'success'`, or
use `payments.paid_at IS NOT NULL`. There is no `payments.status` column and no
`payments.gateway` column; the columns are `gateway_status` and
`payment_method`. Likewise `enrollments` has no status column — an enrollment
row means the learner has access, subject to `expires_at`.

**Revenue should be counted from `orders.status = 'paid'`**, not from payments:
one order can have many payment attempts, so summing payments double-counts.

## Polymorphic tables

Laravel stores the model class name in a `*_type` column. Values are fully
qualified with backslashes, so escape or match carefully:

| Table | Type column | Values seen |
| --- | --- | --- |
| `ratings` | `rateable_type` | `App\Models\Course` |
| `favorites` | `favoritable_type` | `App\Models\Course`, `App\Models\Category` |
| `taggables` | `taggable_type` | `App\Models\Course`, `App\Models\Learner` |
| `resources` | `resourceable_type` | `App\Models\Course` |
| `notifications` | `notifiable_type` | user/learner models |

```sql
SELECT AVG(score) FROM ratings
 WHERE rateable_type = 'App\Models\Course' AND rateable_id = 12;
```

Always filter on the `*_type` column before joining on `*_id`, or you will join
IDs across unrelated tables.

## Units and other traps

- **Money is an integer in Iraqi dinar (IQD)** — `courses.price`,
  `bundles.price`, `orders.amount`, `payments.amount`. No minor units, no
  decimals: `89000` means 89,000 IQD. Free items are `0`, and a legitimately
  paid order can have `amount = 0` (promotions).
- **`lesson_watches.progress` is seconds watched**, not a percentage. Compare
  against `lessons.duration` (also seconds); a few rows slightly exceed the
  duration, so clamp before computing completion percentages.
- **`bundles` is the only soft-deleted table** (`deleted_at`); exclude
  `deleted_at IS NOT NULL` unless asked about deleted bundles. Elsewhere,
  visibility is `is_visible` on `courses`, `bundles`, and `instructors`.
- **Infra tables are structure-only** — `cache`, `cache_locks`, `jobs`,
  `job_batches`, `failed_jobs`, `personal_access_tokens` are deliberately empty
  in this copy. `migrations`, `sessions`, and `password_reset_tokens` carry no
  analytical value.
- Some tables may legitimately be empty (`quiz_attempts` currently is) — report
  a zero as a zero rather than assuming the query is wrong.

## Common joins

```sql
-- learner account details for anything keyed by learner_id
SELECT u.name, u.email
  FROM learners l JOIN users u ON u.id = l.user_id;

-- paid revenue per course
SELECT c.title->>'en' AS course, COUNT(*) AS orders, SUM(o.amount) AS iqd
  FROM orders o JOIN courses c ON c.id = o.course_id
 WHERE o.status = 'paid'
 GROUP BY 1 ORDER BY iqd DESC;

-- enrolled learners per course
SELECT c.title->>'en', COUNT(DISTINCT e.learner_id)
  FROM enrollments e JOIN courses c ON c.id = e.course_id
 GROUP BY 1;

-- learners who have at least one order
SELECT COUNT(DISTINCT learner_id) FROM orders;

-- a learner's watch progress in a course
SELECT l.title->>'en', lw.progress, l.duration
  FROM lesson_watches lw
  JOIN lessons l ON l.id = lw.lesson_id
 WHERE lw.learner_id = $1 AND l.course_id = $2;
```
