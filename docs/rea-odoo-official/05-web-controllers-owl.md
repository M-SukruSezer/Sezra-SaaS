# 05 - Controllers, HTTP Surface, and the OWL Frontend

Phase 3 output. Routes were extracted by AST-walking every `controllers/*.py`
decorator in all 693 modules. Frontend figures come from scanning
`static/src/**` (regex, not AST, since JS is not parsed by Python's `ast`) —
so **JS counts are approximate where route counts are exact.**

## HTTP surface census

| Metric | Value |
|---|---|
| Modules with a `controllers/` directory | 157 |
| `@route` decorators | 1,001 |
| Distinct URL patterns | 1,036 |
| `type='http'` (raw HTTP) | 586 |
| `type='jsonrpc'` | 409 |
| `type='json2'` | 6 |

**`type='jsonrpc'` is the Odoo 20 spelling.** Older releases used
`type='json'`. Any controller carried forward from an earlier version with
`type='json'` will not route the same way. A third type, `json2`, appears on
only 6 routes and is paired almost exclusively with bearer-token auth — the
beginning of a conventional token-authenticated API surface distinct from the
session-cookie RPC that Odoo has always used.

### Authentication x type matrix

| `auth` | http | jsonrpc | json2 | Total | Meaning |
|---|---|---|---|---|---|
| `public` | 331 | 187 | 1 | **519** | No login; `env.user` is the public user |
| `user` | 218 | 181 | 2 | **401** | Session required |
| `none` | 29 | 9 | 0 | 38 | No environment at all; used before DB selection |
| `force_guest` | 2 | 21 | 0 | 23 | Discuss/livechat guest identity |
| `outlook` | 0 | 8 | 0 | 8 | Provider-specific token validation |
| `calendar` | 5 | 0 | 0 | 5 | Calendar invitation token |
| `bearer` | 1 | 0 | 3 | 4 | Token auth; the `json2` partner |
| `force_guest_optional` | 0 | 3 | 0 | 3 | Guest if present, else anonymous |

**519 public routes against 401 authenticated ones.** More than half the HTTP
surface is reachable without a session. That is expected for a product that
ships a CMS, a webshop, a customer portal, and livechat in the same process as
the ERP, but it is also the whole attack surface: every public route is a
place where `ir.access` and record-rule domains are the only thing between an
anonymous request and business data.

The eight distinct `auth` values are worth noting as an extension point:
`auth` is not a fixed enum. `outlook`, `calendar`, `force_guest`, and
`bearer` are registered by modules implementing their own authentication
method on `ir.http`, which is exactly why `ir.http` is extended by 47 modules
(see [02](02-orm-framework-mechanics.md)).

### Route keyword usage

| Keyword | Observed | Reading |
|---|---|---|
| `methods` unspecified | 668 | Accepts any verb. The default, and the majority |
| `methods=['POST']` | 234 | |
| `methods=['GET']` | 85 | |
| `methods=['GET','POST']` | 10 | |
| `website=True` | 458 | Route participates in multi-website context, language prefixing, and theming |
| `sitemap=False` | 145 | Explicitly excluded from `/sitemap.xml` |
| `sitemap=True` or callable | 15 | Explicitly included, 2 via a generator function |
| `csrf=False` | 77 | **Inbound webhook endpoints.** CSRF cannot apply to a third-party POST |
| `csrf=True` | 3 | Explicit re-assertion |
| `readonly=True` | 138 | |
| `readonly=False` | 5 | |
| `readonly=<callable>` | 6 | Decided per request, e.g. `_is_mail_fetch_readonly`, `_call_kw_readonly` |

**`readonly` on 149 routes is the one to know about.** It is a routing-layer
declaration that a request performs no writes, which lets the request be served
from a read-only database connection (a replica) instead of the primary. Six
routes compute it dynamically because the same endpoint can be read-only or not
depending on payload — `_call_kw_readonly` is the generic RPC entry point
deciding per method call. This is infrastructure for horizontal read scaling and
it is opt-in: an un-annotated route takes a write connection.

### URL converters

Odoo extends Werkzeug's routing with ORM-aware converters.

| Converter | Occurrences |
|---|---|
| `<int:...>` | 236 |
| `<model("..."):...>` | 175 (across 130 patterns) |
| `<string(...):...>` | 113 |
| `<path:...>` | 21 |
| `<models("..."):...>` | 5 |
| `<any(...):...>` | 2 |

The `model` converter is the interesting one: it resolves an id or slug in the
URL into a live recordset **during routing**, before the handler body runs, and
applies access checks there. A route like
`/shop/<model("product.template"):product_template>/document/<int:document_id>`
has already loaded and access-checked the product by the time the handler
executes. A 404 from a missing or forbidden record therefore originates in the
router, not in controller code — which is why so few handlers contain explicit
existence checks.

### Route distribution by module

| Routes | Module | http | jsonrpc | public | user |
|---|---|---|---|---|---|
| 73 | `web` | 48 | 25 | 13 | 37 |
| 69 | `mail` | 19 | 50 | 44 | 23 |
| 64 | `website` | 30 | 34 | 30 | 34 |
| 62 | `website_sale` | 25 | 37 | 48 | 14 |
| 51 | `im_livechat` | 14 | 37 | 14 | 9 |
| 41 | `website_forum` | 34 | 7 | 10 | 31 |
| 39 | `website_slides` | 14 | 25 | 19 | 20 |
| 37 | `test_website` | 30 | 7 | 37 | 0 |
| 31 | `iot_drivers` | 19 | 12 | 0 | 31 |
| 23 | `survey` | 15 | 8 | 13 | 10 |
| 17 | `html_editor` | 3 | 14 | 3 | 14 |
| 17 | `mass_mailing` | 13 | 4 | 14 | 3 |
| 17 | `pos_self_order` | 3 | 14 | 16 | 1 |
| 16 | `portal` | 10 | 6 | 3 | 13 |
| 15 | `hr_attendance` | 3 | 12 | 10 | 5 |
| 14 | `sale` | 6 | 8 | 6 | 8 |
| 14 | `website_event_track` | 10 | 4 | 14 | 0 |
| 11 | `point_of_sale` | 9 | 2 | 5 | 6 |
| 10 | `account` | 9 | 1 | 3 | 7 |
| 10 | `calendar` | 8 | 2 | 2 | 3 |

**`mail` is 50 jsonrpc routes out of 69** — Discuss is effectively a chat
application with its own RPC protocol living inside the ERP. `website_sale` is
the most public-weighted module of consequence (48 of 62 public), as a webshop
must be.

Note `iot_drivers`: 31 routes, zero public, and the module is
`installable: False`. Its HTTP surface runs in the separate IoT box process,
not in the Odoo server.

### URL namespaces

First path segment, by pattern count:

| Patterns | Prefix | Owner |
|---|---|---|
| 98 | `/web` | Web client, assets, binary content |
| 79 | `/my` | Customer portal (orders, invoices, tickets) |
| 62 | `/website` | CMS operations |
| 53 | `/mail` | Discuss + mail tracking |
| 51 | `/slides` | eLearning |
| 46 | `/forum` | |
| 39 | `/im_livechat` | |
| 39 | `/shop` | eCommerce |
| 38 | `/event` | |
| 25 | `/iot_drivers` | |
| 23 | `/discuss` | |
| 22 | `/survey` | |
| 21 | `/web_editor` | |
| 17 | `/html_editor` | |
| 15 | `/hr_attendance`, `/payment`, `/pos-self-order` | |
| 13 | `/mail_plugin`, `/pos`, `/partners` | |
| 12 | `/mailing` | |
| 11 | `/blog` | |

**`/payment` carries only 15 patterns but is the most security-sensitive
namespace in the system.** All of `/payment/status`, `/payment/process`,
`/payment/pay`, `/payment/transaction`, and `/payment/confirmation` are
`auth='public'`, because payment-provider webhooks arrive unauthenticated.
Those are the routes with `csrf=False`, and the idempotency lock at
`payment/models/payment_transaction.py:1327` (see
[04](04-workflows-sequence.md)) is what protects them from replayed
notifications.

## OWL frontend architecture

| Metric | Value |
|---|---|
| Modules with `static/src/` | 320 |
| JavaScript files | 4,246 |
| `extends Component` occurrences | 1,372 |
| OWL templates (`<t t-name=...>`) | 2,814 |
| `patch(...)` calls | 764 |
| SCSS/CSS files | 1,241 |
| Modules declaring `assets` bundles | 329 |
| Distinct registered services | 116 |

**2,814 templates against 1,372 components** — roughly two templates per
component, because OWL components commonly define a main template plus
sub-templates for variants.

### The registry is the extension mechanism

OWL has no dependency injection container. Extension happens through named
registries, and the category name is the contract. Measured occurrences of
`registry.category("...")`:

| Occurrences | Category | What plugs in |
|---|---|---|
| 360 | `fields` | Field widgets. The largest extension point in the frontend by a wide margin |
| 185 | `views` | View types (list, kanban, gantt, map, ...) |
| 123 | `services` | Long-lived singletons (ORM, notification, dialog, bus) |
| 123 | `public.interactions` | **Frontend (website-side) behaviors** |
| 108 | `website-plugins` | |
| 64 | `public.interactions.edit` | Edit-mode counterparts of the above |
| 64 | `website-options` | Snippet option panels |
| 53 | `view_widgets` | Widgets embeddable in a view but not bound to a field |
| 43 | `actions` | Client actions |
| 26 | `web_tour.tours` | Onboarding tours (also the integration-test harness) |
| 25 | `formatters`, `builder-plugins` | |
| 24 | `main_components` | Top-level always-mounted components |
| 23 | `pos_available_models` | POS offline model preload set |
| 19 | `translation-plugins` | |
| 18 | `mass_mailing-plugins` | |
| 15 | `cogMenu`, `pos_payment_providers` | |
| 14 | `pos_pages` | |
| 12 | `builder-options` | |
| 11 | `systray` | |
| 10 | `command_provider` | Command-palette sources |

**`fields` at 360 is the single most important number for anyone extending
Odoo's UI.** Adding a field widget is the most common frontend customization,
and it needs no patching: register under a name, reference that name from the
view's `widget=` attribute.

**`public.interactions` (123 + 64 edit-mode) is the Odoo 18-onward replacement
for the old `publicWidget` system.** Website-side JavaScript is now registered
interactions with explicit edit-mode variants, rather than jQuery-era widgets
bound by CSS selector. The paired `.edit` registry exists because website
content must behave differently while the page builder is open.

The `builder-plugins` / `builder-options` / `website-plugins` /
`website-options` cluster is the `html_builder` architecture — the page editor
is itself a plugin host.

### Component concentration

| Components | JS files | Templates | `patch()` | Module |
|---|---|---|---|---|
| 310 | 564 | 418 | 5 | `web` |
| 191 | 91 | 397 | 12 | `spreadsheet` |
| 168 | 451 | 271 | 100 | `mail` |
| 83 | 185 | 105 | 10 | `point_of_sale` |
| 68 | 393 | 312 | 26 | `website` |
| 67 | 222 | 91 | 1 | `html_editor` |
| 49 | 157 | 89 | 1 | `html_builder` |
| 42 | 95 | 87 | 7 | `account` |
| 34 | 74 | 42 | 22 | `pos_self_order` |
| 21 | 44 | 41 | 0 | `stock` |
| 20 | 55 | 40 | 3 | `sale` |
| 16 | 49 | 27 | 7 | `hr` |
| 16 | 42 | 21 | 5 | `mrp` |
| 15 | 22 | 23 | 1 | `hr_attendance` |
| 15 | 19 | 0 | 0 | `iot_drivers` |
| 14 | 80 | 168 | 4 | `mass_mailing` |
| 14 | 53 | 41 | 9 | `website_slides` |
| 13 | 65 | 31 | 20 | `pos_restaurant` |

`spreadsheet` is an outlier: 191 components in 91 files, the densest ratio in
the codebase (a full spreadsheet engine). `iot_drivers` has 15 components and
**zero** templates, consistent with it being a separate device-side
application.

### `patch()` is the escape hatch, and it is unevenly used

764 `patch()` calls modify already-registered classes in place — the frontend
equivalent of Python's `_inherit`. Where registries can't express an extension,
modules patch.

| `patch()` | Components | Module | Reading |
|---|---|---|---|
| 100 | 168 | `mail` | Discuss extends its own components across sub-features |
| 50 | 11 | `im_livechat` | **Ratio of 4.5 patches per component** |
| 26 | 68 | `website` | |
| 22 | 34 | `pos_self_order` | |
| 20 | 13 | `pos_restaurant` | |
| 17 | 2 | `sale_management` | Almost pure patching |
| 17 | 9 | `website_sale` | |
| 16 | 0 | `portal_rating` | **Zero components, 16 patches** |
| 14 | 1 | `pos_loyalty` | |
| 13 | 2 | `pos_stock` | |
| 12 | 11 | `project` | |
| 12 | 191 | `spreadsheet` | |

**`portal_rating` with 16 patches and 0 components is the frontend bridge
pattern in its purest form** — exactly parallel to `sale_stock` on the Python
side (see [04](04-workflows-sequence.md)). The POS bridges (`pos_loyalty`,
`pos_stock`, `pos_restaurant`, `pos_self_order`) behave the same way: they add
almost no UI of their own and instead patch the POS components that already
exist.

**Inference:** a high patch-to-component ratio marks a module as a bridge
rather than a feature. It is also a maintenance signal — patched call sites
break silently on upgrade in a way registry entries do not, since a registry
name is a contract and a patched method body is not.

### Asset bundles

329 modules declare `assets`. Bundle names are the build targets; a module adds
its files to an existing bundle rather than declaring its own.

| Modules contributing | Bundle | Purpose |
|---|---|---|
| 153 | `web.assets_backend` | The web client |
| 126 | `web.assets_tests` | Tour-based integration tests |
| 105 | `web.assets_unit_tests` | Unit tests |
| 103 | `web.assets_frontend` | Public website |
| 50 | `point_of_sale._assets_pos` | POS application |
| 44 | `website.assets_editor` | |
| 22 | `website.website_builder_assets` | |
| 18 | `mail.assets_public` | |
| 17 | `web.assets_unit_tests_setup` | |
| 16 | `web.report_assets_common`, `im_livechat.assets_embed_core` | PDF/report rendering; embeddable livechat |
| 15 | `portal.assets_chatter_helpers` | |
| 14 | `web.assets_web_dark`, `web.assets_backend_lazy` | Dark theme; deferred backend code |
| 11 | `point_of_sale.payment_terminals` | |
| 10 | `web._assets_primary_variables` | SCSS variable layer themes override |
| 9 | `pos_self_order.assets`, `website.assets_inside_builder_iframe` | |
| 5 | `point_of_sale.customer_display_assets` | Second-screen display |

Three facts worth drawing out:

1. **`web.assets_tests` (126) and `web.assets_unit_tests` (105) together
   outnumber `assets_frontend` (103).** Test assets are first-class bundles
   declared in manifests, not a side directory.
2. **`web.assets_backend_lazy` (14)** exists so backend code can be excluded
   from the initial bundle and fetched on demand — the lever for web-client
   load time.
3. **`web._assets_primary_variables` (10)** is the SCSS variable injection
   point. The 36 Theme modules set brand variables here, which is how a theme
   restyles the whole frontend without touching component code.

## Residual unknowns

1. **JS figures are regex-derived.** `extends Component` misses components
   created by other means (factory functions, class expressions), and
   `patch(` would match an unrelated local function of that name. Treat the
   1,372 and 764 as close lower bounds, not exact counts.
2. **No route was requested.** Auth behavior, CSRF enforcement, and the
   `readonly` connection routing are read from decorator metadata only.
3. **Asset bundle contents were not resolved.** Counts are of modules
   *declaring* a contribution; actual file lists, load order, and the
   `prepend`/`replace`/`after` directives were not expanded.
4. **`ir.ui.view` inheritance was not analyzed.** QWeb template overriding via
   `xpath` is a separate extension mechanism from the OWL registry and is not
   covered by this pass.
