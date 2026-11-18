'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./transport.js');

const NOW = new Date(2030, 0, 10, 12, 0).getTime(); // fixed clock: 10 Jan 2030, 12:00 local
const DAY = '2030-01-11';

function seeded() {
  let s = T.emptyState();
  s = T.addRoute(s, { name: 'Line 1', stops: 'A, B, C, D', durationMin: 60, fare: '50' });
  s = T.addVehicle(s, { regNo: 'ka 01-ab 1234', type: 'Bus', capacity: 3 });
  s = T.addTrip(s, { routeId: 'R1', vehicleId: 'V2', departure: `${DAY}T09:00` }, NOW);
  return s;
}
const book = (s, extra = {}) =>
  T.bookTicket(s, { tripId: 'T3', passengerName: 'Asha', phone: '9876543210', seats: 1, ...extra }, NOW);

const rejects = (fn, pattern) => assert.throws(fn, (e) => e instanceof T.ValidationError && pattern.test(e.message));

// ---- normal cases ----

test('seeded state has normalised data', () => {
  const s = seeded();
  assert.deepEqual(s.routes[0].stops, ['A', 'B', 'C', 'D']);
  assert.equal(s.routes[0].farePaise, 5000);
  assert.equal(s.vehicles[0].regNo, 'KA01AB1234');
  assert.equal(s.trips[0].arrival - s.trips[0].departure, 60 * 60000);
});

test('mutators do not modify the input state', () => {
  const s = seeded();
  const snapshot = JSON.stringify(s);
  book(s);
  assert.equal(JSON.stringify(s), snapshot);
});

test('booking computes fare and reduces seats; cancel frees them', () => {
  let s = book(seeded(), { seats: 2, from: 'b', to: 'D' });
  const b = s.bookings[0];
  assert.equal(b.totalPaise, 10000);
  assert.equal(b.from, 'B');
  assert.equal(T.seatsLeft(s, s.trips[0]), 1);
  s = T.cancelBooking(s, b.id, NOW);
  assert.equal(T.seatsLeft(s, s.trips[0]), 3);
});

test('search matches direction, date and sorts by departure', () => {
  let s = seeded();
  s = T.addTrip(s, { routeId: 'R1', vehicleId: 'V2', departure: `${DAY}T07:00` }, NOW);
  const found = T.searchTrips(s, { from: 'b', to: 'd', date: DAY }, NOW);
  assert.deepEqual(found.map((r) => r.trip.id), ['T4', 'T3']);
  assert.equal(T.searchTrips(s, { from: 'D', to: 'B' }, NOW).length, 0, 'wrong direction');
  assert.equal(T.searchTrips(s, { date: '2030-01-12' }, NOW).length, 0, 'other date');
  assert.equal(T.searchTrips(s, { from: 'Z' }, NOW).length, 0, 'unknown stop');
});

test('back-to-back trips for one vehicle are allowed', () => {
  const s = T.addTrip(seeded(), { routeId: 'R1', vehicleId: 'V2', departure: `${DAY}T10:00` }, NOW);
  assert.equal(s.trips.length, 2);
});

// ---- edge cases ----

test('booking exactly the remaining seats, then the trip is full', () => {
  const s = book(seeded(), { seats: 3 });
  rejects(() => book(s), /full/);
});

test('date helpers round-trip and reject impossible dates', () => {
  const ms = T.parseLocalDateTime('2030-03-05T07:09');
  assert.equal(T.formatLocalDateTime(ms), '2030-03-05T07:09');
  assert.equal(T.parseLocalDateTime('2030-03-05T07:09:00'), ms);
  rejects(() => T.parseLocalDateTime('2030-02-30T10:00', 'Departure'), /not a valid/);
  rejects(() => T.parseLocalDateTime('tomorrow', 'Departure'), /must be a date/);
});

test('parseState: empty -> fresh state; corrupt -> error', () => {
  assert.deepEqual(T.parseState(null), T.emptyState());
  assert.deepEqual(T.parseState(JSON.stringify(seeded())), seeded());
  rejects(() => T.parseState('{not json'), /not valid JSON/);
  rejects(() => T.parseState('{"version":99}'), /unknown format/);
});

test('whitespace is collapsed in names', () => {
  const s = T.addRoute(T.emptyState(), { name: '  Ring   Road ', stops: ' X ,  Y ', durationMin: '30', fare: '10.5' });
  assert.equal(s.routes[0].name, 'Ring Road');
  assert.equal(s.routes[0].farePaise, 1050);
});

// ---- failure cases ----

test('route validation', () => {
  const s = seeded();
  rejects(() => T.addRoute(s, { name: 'line 1', stops: 'X, Y', durationMin: 10, fare: '5' }), /already exists/);
  rejects(() => T.addRoute(s, { name: 'L2', stops: 'X', durationMin: 10, fare: '5' }), /at least 2 stops/);
  rejects(() => T.addRoute(s, { name: 'L2', stops: 'X, x', durationMin: 10, fare: '5' }), /more than once/);
  rejects(() => T.addRoute(s, { name: 'L2', stops: 'X, Y', durationMin: 0, fare: '5' }), /Duration/);
  rejects(() => T.addRoute(s, { name: 'L2', stops: 'X, Y', durationMin: 10, fare: '-5' }), /amount/);
  rejects(() => T.addRoute(s, { name: 'L2', stops: 'X, Y', durationMin: 10, fare: '0.50' }), /between/);
  rejects(() => T.addRoute(s, { name: '', stops: 'X, Y', durationMin: 10, fare: '5' }), /required/);
});

test('vehicle validation', () => {
  const s = seeded();
  rejects(() => T.addVehicle(s, { regNo: 'KA01AB1234', type: 'Bus', capacity: 10 }), /already registered/);
  rejects(() => T.addVehicle(s, { regNo: 'A1', type: 'Bus', capacity: 10 }), /Registration/);
  rejects(() => T.addVehicle(s, { regNo: 'ABCD12', type: 'Rocket', capacity: 10 }), /type/);
  rejects(() => T.addVehicle(s, { regNo: 'ABCD12', type: 'Van', capacity: 101 }), /Capacity/);
  rejects(() => T.addVehicle(s, { regNo: 'ABCD12', type: 'Van', capacity: 2.5 }), /Capacity/);
});

test('trip validation', () => {
  const s = seeded();
  rejects(() => T.addTrip(s, { routeId: 'R1', vehicleId: 'V2', departure: '2030-01-09T09:00' }, NOW), /future/);
  rejects(() => T.addTrip(s, { routeId: 'R1', vehicleId: 'V2', departure: `${DAY}T09:30` }, NOW), /already on trip/);
  rejects(() => T.addTrip(s, { routeId: 'R9', vehicleId: 'V2', departure: `${DAY}T12:00` }, NOW), /Route not found/);
});

test('booking validation', () => {
  const s = seeded();
  rejects(() => book(s, { phone: '12ab' }), /Phone/);
  rejects(() => book(s, { seats: 0 }), /Seats/);
  rejects(() => book(s, { seats: 7 }), /Seats/);
  rejects(() => book(s, { seats: 4 }), /Only 3 seat/);
  rejects(() => book(s, { from: 'C', to: 'B' }), /before the drop-off/);
  rejects(() => book(s, { from: 'Q' }), /must be on route/);
  rejects(() => book(s, { passengerName: '   ' }), /required/);
  rejects(() => book(s, { tripId: 'T999' }), /Trip not found/);
  const later = new Date(2030, 0, 11, 9, 0).getTime();
  rejects(() => T.bookTicket(s, { tripId: 'T3', passengerName: 'A', phone: '1234567', seats: 1 }, later), /departed/);
});

test('cancellation and deletion guards', () => {
  const s = book(seeded());
  const cancelled = T.cancelBooking(s, 'B4', NOW);
  rejects(() => T.cancelBooking(cancelled, 'B4', NOW), /already cancelled/);
  rejects(() => T.cancelBooking(s, 'B4', new Date(2030, 0, 11, 9, 0).getTime()), /after departure/);
  rejects(() => T.removeTrip(s, 'T3'), /confirmed bookings/);
  rejects(() => T.removeRoute(s, 'R1'), /has trips/);
  rejects(() => T.removeVehicle(s, 'V2'), /has trips/);
  assert.equal(T.removeTrip(cancelled, 'T3').trips.length, 0);
});

test('search rejects identical stops and bad dates', () => {
  rejects(() => T.searchTrips(seeded(), { from: 'A', to: 'a' }, NOW), /different/);
  rejects(() => T.searchTrips(seeded(), { date: '11/01/2030' }, NOW), /YYYY-MM-DD/);
});
