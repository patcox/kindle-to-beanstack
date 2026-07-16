import { test } from "node:test";
import assert from "node:assert/strict";
import { mondayOf, addDays, aggregateByTitle, aggregateByWeek, buildKidReport, buildReport } from "../extension/lib/report.js";

test("mondayOf finds the Monday of the containing week", () => {
  // 2026-07-01 is a Wednesday
  assert.equal(mondayOf("2026-07-01"), "2026-06-29");
  // 2026-06-29 is itself a Monday
  assert.equal(mondayOf("2026-06-29"), "2026-06-29");
  // 2026-07-05 is a Sunday, belongs to the week starting 2026-06-29
  assert.equal(mondayOf("2026-07-05"), "2026-06-29");
});

test("addDays adds calendar days correctly, including across month boundaries", () => {
  assert.equal(addDays("2026-06-29", 6), "2026-07-05");
  assert.equal(addDays("2026-06-29", 1), "2026-06-30");
});

const sampleEntries = [
  { date: "2026-07-01", asin: "B0TESTWIMPY", title: "Diary of a Wimpy Kid", minutes: 30 },
  { date: "2026-07-02", asin: "B0TESTDOGMAN", title: "Dog Man", minutes: 45 },
  { date: "2026-07-02", asin: "B0TESTWIMPY", title: "Diary of a Wimpy Kid", minutes: 10 },
  { date: "2026-07-08", asin: "B0TESTDOGMAN", title: "Dog Man", minutes: 20 },
];

test("aggregateByTitle sums minutes per title (keyed by asin) and sorts descending", () => {
  const result = aggregateByTitle(sampleEntries);
  assert.deepEqual(result, [
    { title: "Diary of a Wimpy Kid", asin: "B0TESTWIMPY", minutes: 40 },
    { title: "Dog Man", asin: "B0TESTDOGMAN", minutes: 65 },
  ].sort((a, b) => b.minutes - a.minutes));
});

test("aggregateByWeek buckets entries into Mon–Sun weeks", () => {
  const result = aggregateByWeek(sampleEntries);
  assert.deepEqual(result, [
    { weekStart: "2026-06-29", weekEnd: "2026-07-05", minutes: 85 },
    { weekStart: "2026-07-06", weekEnd: "2026-07-12", minutes: 20 },
  ]);
});

test("buildKidReport combines titles, weeks, and a total", () => {
  const report = buildKidReport(sampleEntries);
  assert.equal(report.totalMinutes, 105);
  assert.equal(report.titles.length, 2);
  assert.equal(report.weeks.length, 2);
});

test("buildReport groups entries by kid via childDirectedId", () => {
  const dataset = [
    { childDirectedId: "c1", date: "2026-07-01", asin: "B1", title: "Book A", minutes: 10 },
    { childDirectedId: "c2", date: "2026-07-01", asin: "B2", title: "Book B", minutes: 20 },
  ];
  const kids = [
    { childDirectedId: "c1", name: "Alex" },
    { childDirectedId: "c2", name: "Sam" },
  ];
  const report = buildReport(dataset, kids);
  assert.equal(report.c1.name, "Alex");
  assert.equal(report.c1.totalMinutes, 10);
  assert.equal(report.c2.name, "Sam");
  assert.equal(report.c2.totalMinutes, 20);
});
