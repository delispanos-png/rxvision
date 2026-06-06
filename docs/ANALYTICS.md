# RxVision — Analytics (MongoDB Aggregation Pipelines)

Κανόνας: **πρώτο stage πάντα `$match` με `tenant_id`** (+ date range) ώστε να «χτυπά» το
compound index και να κλειδώνει το tenant isolation. Παρακάτω παραδείγματα — οι builders
ζουν στο [backend/app/analytics/](../backend/app/analytics/).

> Σύμβαση: `cents` integers· χρόνοι UTC· `tid` = ObjectId tenant· περίοδος μέσω `$match`.

## 1. Εκτελέσεις ανά ημέρα
```js
db.prescription_executions.aggregate([
  { $match: { tenant_id: tid, executed_at: { $gte: from, $lt: to } } },
  { $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$executed_at", timezone: "Europe/Athens" } },
      count: { $sum: 1 },
      value: { $sum: "$amount_total" },
      claimed: { $sum: "$amount_claimed" } } },
  { $sort: { _id: 1 } }
])
```

## 2. Αξία ανά ταμείο
```js
db.prescription_executions.aggregate([
  { $match: { tenant_id: tid, executed_at: { $gte: from, $lt: to } } },
  { $group: { _id: "$fund_id", count: { $sum: 1 },
              value: { $sum: "$amount_total" }, claimed: { $sum: "$amount_claimed" } } },
  { $lookup: { from: "insurance_funds", localField: "_id", foreignField: "_id", as: "fund" } },
  { $set: { fund: { $first: "$fund.name" } } },
  { $sort: { claimed: -1 } }
])
```

## 3. Top ιατροί (ανά αξία)
```js
db.prescription_executions.aggregate([
  { $match: { tenant_id: tid, executed_at: { $gte: from, $lt: to } } },
  { $group: { _id: "$doctor_id", rx: { $sum: 1 }, value: { $sum: "$amount_total" } } },
  { $sort: { value: -1 } }, { $limit: 10 },
  { $lookup: { from: "doctors", localField: "_id", foreignField: "_id", as: "d" } },
  { $set: { name: { $first: "$d.full_name" }, specialty: { $first: "$d.specialty" } } },
  { $project: { d: 0 } }
])
```

## 4. Top ICD-10
```js
db.prescription_executions.aggregate([
  { $match: { tenant_id: tid, executed_at: { $gte: from, $lt: to } } },
  { $unwind: "$icd10" },
  { $group: { _id: "$icd10", rx: { $sum: 1 }, value: { $sum: "$amount_total" } } },
  { $sort: { rx: -1 } }, { $limit: 10 },
  { $lookup: { from: "icd10_codes", localField: "_id", foreignField: "_id", as: "c" } },
  { $set: { title: { $first: "$c.title_el" } } }, { $project: { c: 0 } }
])
```

## 5. Top σκευάσματα (από items)
```js
db.prescription_items.aggregate([
  { $match: { tenant_id: tid, executed_at: { $gte: from, $lt: to }, is_executed: true } },
  { $group: { _id: "$product_id", qty: { $sum: "$quantity" },
              value: { $sum: { $multiply: ["$retail_price", "$quantity"] } } } },
  { $sort: { qty: -1 } }, { $limit: 10 },
  { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "p" } },
  { $set: { name: { $first: "$p.name" } } }, { $project: { p: 0 } }
])
```

## 6. Κερδοφορία ανά συνταγή (αιτούμενο vs χονδρική)
```js
db.prescription_executions.aggregate([
  { $match: { tenant_id: tid, executed_at: { $gte: from, $lt: to } } },
  { $set: { gross_profit: { $subtract: ["$amount_claimed", "$wholesale_cost"] } } },
  { $set: { margin_pct: { $cond: [ { $gt: ["$amount_claimed", 0] },
            { $multiply: [ { $divide: ["$gross_profit", "$amount_claimed"] }, 100 ] }, 0 ] } } },
  { $group: { _id: null, total_claimed: { $sum: "$amount_claimed" },
              total_cost: { $sum: "$wholesale_cost" },
              total_profit: { $sum: "$gross_profit" },
              avg_margin_pct: { $avg: "$margin_pct" } } }
])
```

## 7. Κερδοφορία ανά ιατρό
```js
db.prescription_executions.aggregate([
  { $match: { tenant_id: tid, executed_at: { $gte: from, $lt: to } } },
  { $group: { _id: "$doctor_id",
              claimed: { $sum: "$amount_claimed" }, cost: { $sum: "$wholesale_cost" } } },
  { $set: { profit: { $subtract: ["$claimed", "$cost"] },
            margin_pct: { $cond: [ { $gt: ["$claimed", 0] },
              { $multiply: [ { $divide: [ { $subtract: ["$claimed","$cost"] }, "$claimed" ] }, 100 ] }, 0 ] } } },
  { $sort: { profit: -1 } },
  { $lookup: { from: "doctors", localField: "_id", foreignField: "_id", as: "d" } },
  { $set: { name: { $first: "$d.full_name" } } }, { $project: { d: 0 } }
])
```

## 8. Νέοι πελάτες ανά ιατρό
«Νέος πελάτης» = ασθενής του οποίου η **πρώτη** εμφάνιση στο φαρμακείο έγινε μέσω συνταγής
αυτού του ιατρού, εντός περιόδου.
```js
db.prescription_executions.aggregate([
  { $match: { tenant_id: tid } },
  { $sort: { executed_at: 1 } },
  { $group: { _id: "$patient_ref",                       // πρώτη συνταγή ανά ασθενή
              first_at: { $first: "$executed_at" },
              first_doctor: { $first: "$doctor_id" } } },
  { $match: { first_at: { $gte: from, $lt: to } } },       // πρώτη εμφάνιση μέσα στην περίοδο
  { $group: { _id: "$first_doctor", new_patients: { $sum: 1 } } },
  { $sort: { new_patients: -1 } },
  { $lookup: { from: "doctors", localField: "_id", foreignField: "_id", as: "d" } },
  { $set: { name: { $first: "$d.full_name" } } }, { $project: { d: 0 } }
])
```

## 9. Μελλοντικές συνταγές ανά ημέρα
```js
db.future_prescriptions.aggregate([
  { $match: { tenant_id: tid, status: "pending",
              expected_open_date: { $gte: today, $lt: horizon } } },
  { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$expected_open_date" } },
              count: { $sum: 1 } } },
  { $sort: { _id: 1 } }
])
```

## 10. Είδη χαμηλής κερδοφορίας
```js
db.products.aggregate([
  { $match: { tenant_id: tid, margin_pct: { $lt: 10 }, rx_frequency: { $gt: 0 } } },
  { $sort: { rx_frequency: -1 } },     // χαμηλό margin αλλά συχνά → priority
  { $project: { name: 1, category: 1, retail_price: 1, wholesale_price: 1,
                margin_pct: 1, rx_frequency: 1 } }, { $limit: 50 }
])
```

## Bonus — Order suggestions (μελλοντικές + ιστορικότητα + safety stock)
```js
db.future_prescriptions.aggregate([
  { $match: { tenant_id: tid, status: "pending",
              expected_open_date: { $gte: today, $lt: leadHorizon } } },
  { $unwind: "$products" },
  { $group: { _id: "$products.product_id", expected_demand: { $sum: "$products.expected_qty" } } },
  // ιστορικός μέσος ημερήσιας ζήτησης (παράδειγμα join σε precomputed)
  { $lookup: { from: "profitability_snapshots", /* ή ξεχωριστό demand snapshot */
               localField: "_id", foreignField: "dimension_id", as: "hist" } },
  { $set: { suggested_qty: { $ceil: { $multiply: ["$expected_demand", 1.15] } } } }, // +safety stock
  { $sort: { suggested_qty: -1 } }
])
```

## Caching & precompute
- **Hot dashboards:** nightly Celery `snapshots_*` γράφει `profitability_snapshots` &
  daily KPI docs· τα endpoints διαβάζουν αυτά (όχι raw scan).
- **Ad-hoc φίλτρα:** Redis cache key = `hash(tenant_id+endpoint+filters)`, TTL 5–15′.
- **Indexes:** βλ. [DATABASE.md](DATABASE.md). Κάθε pipeline σχεδιάστηκε να ξεκινά με
  `$match` που ταιριάζει σε υπάρχον compound index.
