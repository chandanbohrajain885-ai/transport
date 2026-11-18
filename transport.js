/*
 * Transport System - domain logic.
 * Pure functions: each mutator takes a state object and returns a NEW state,
 * or throws ValidationError with a message safe to show to the user.
 * Works in the browser (window.Transport) and in Node (require) for tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Transport = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ValidationError';
    }
  }

  const SCHEMA_VERSION = 1;
  const MAX_TEXT = 60;
  const MAX_STOPS = 30;
  const MAX_SEATS_PER_BOOKING = 6;
  const VEHICLE_TYPES = ['Bus', 'Mini bus', 'Van'];

  // ---------- helpers ----------

  const key = (s) => s.toLowerCase();
  const clone = (state) => JSON.parse(JSON.stringify(state));
  const pad = (n) => String(n).padStart(2, '0');

  function nextId(state, prefix) {
    const id = prefix + state.seq;
    state.seq += 1;
    return id;
  }

  function cleanText(value, field, max = MAX_TEXT) {
    if (typeof value !== 'string') throw new ValidationError(`${field} is required.`);
    const v = value.trim().replace(/\s+/g, ' ');
    if (!v) throw new ValidationError(`${field} is required.`);
    if (v.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`);
    return v;
  }

  function toInt(value, field, min, max) {
    const str = String(value ?? '').trim();
    const n = Number(str);
    if (str === '' || !Number.isInteger(n) || n < min || n > max) {
      throw new ValidationError(`${field} must be a whole number from ${min} to ${max}.`);
    }
    return n;
  }

  // Money is stored as integer paise to avoid floating-point rounding errors.
  function toPaise(value, field) {
    const str = String(value ?? '').trim();
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(str)) {
      throw new ValidationError(`${field} must be an amount like 45 or 45.50.`);
    }
    const paise = Math.round(Number(str) * 100);
    if (paise < 100 || paise > 1000000) {
      throw new ValidationError(`${field} must be between ₹1 and ₹10,000.`);
    }
    return paise;
  }

  function parseStops(raw) {
    const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const stops = parts
      .map((p) => (typeof p === 'string' ? p.trim().replace(/\s+/g, ' ') : ''))
      .filter(Boolean);
    if (stops.length < 2) throw new ValidationError('A route needs at least 2 stops, separated by commas.');
    if (stops.length > MAX_STOPS) throw new ValidationError(`A route can have at most ${MAX_STOPS} stops.`);
    const seen = new Set();
    for (const stop of stops) {
      if (stop.length > MAX_TEXT) throw new ValidationError(`Stop names must be at most ${MAX_TEXT} characters.`);
      if (seen.has(key(stop))) throw new ValidationError(`Stop "${stop}" appears more than once.`);
      seen.add(key(stop));
    }
    return stops;
  }

  /** Parses "YYYY-MM-DDTHH:MM" (seconds optional) as LOCAL time; rejects impossible dates like Feb 30. */
  function parseLocalDateTime(value, field) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? '').trim());
    if (!m) throw new ValidationError(`${field} must be a date and time.`);
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const date = new Date(y, mo - 1, d, h, mi);
    if (
      date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d ||
      date.getHours() !== h || date.getMinutes() !== mi
    ) {
      throw new ValidationError(`${field} is not a valid date and time.`);
    }
    return date.getTime();
  }

  function formatLocalDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatLocalDateTime(ms) {
    const d = new Date(ms);
    return `${formatLocalDate(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function findById(list, id, label) {
    const item = list.find((x) => x.id === id);
    if (!item) throw new ValidationError(`${label} not found. Pick one from the list.`);
    return item;
  }

  function stopIndex(route, name) {
    const k = key(name);
    return route.stops.findIndex((s) => key(s) === k);
  }

  // ---------- state ----------

  function emptyState() {
    return { version: SCHEMA_VERSION, routes: [], vehicles: [], trips: [], bookings: [], seq: 1 };
  }

  /** Returns a state from stored JSON. Missing data -> empty state; corrupt data -> throws. */
  function parseState(json) {
    if (json === null || json === undefined || json === '') return emptyState();
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      throw new ValidationError('Saved data is not valid JSON.');
    }
    const ok =
      data && data.version === SCHEMA_VERSION &&
      ['routes', 'vehicles', 'trips', 'bookings'].every((k) => Array.isArray(data[k])) &&
      Number.isInteger(data.seq) && data.seq >= 1;
    if (!ok) throw new ValidationError('Saved data has an unknown format.');
    return data;
  }

  function seatsBooked(state, tripId) {
    return state.bookings
      .filter((b) => b.tripId === tripId && b.status === 'confirmed')
      .reduce((sum, b) => sum + b.seats, 0);
  }

  function seatsLeft(state, trip) {
    const vehicle = findById(state.vehicles, trip.vehicleId, 'Vehicle');
    return vehicle.capacity - seatsBooked(state, trip.id);
  }

  // ---------- routes ----------

  function addRoute(state, input) {
    const s = clone(state);
    const name = cleanText(input.name, 'Route name');
    const stops = parseStops(input.stops);
    const durationMin = toInt(input.durationMin, 'Duration (minutes)', 1, 1440);
    const farePaise = toPaise(input.fare, 'Fare');
    if (s.routes.some((r) => key(r.name) === key(name))) {
      throw new ValidationError(`A route named "${name}" already exists.`);
    }
    s.routes.push({ id: nextId(s, 'R'), name, stops, durationMin, farePaise });
    return s;
  }

  function removeRoute(state, routeId) {
    const s = clone(state);
    findById(s.routes, routeId, 'Route');
    if (s.trips.some((t) => t.routeId === routeId)) {
      throw new ValidationError('This route has trips. Delete its trips first.');
    }
    s.routes = s.routes.filter((r) => r.id !== routeId);
    return s;
  }

  // ---------- vehicles ----------

  function addVehicle(state, input) {
    const s = clone(state);
    const regNo = String(input.regNo ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z0-9]{4,12}$/.test(regNo)) {
      throw new ValidationError('Registration number must be 4-12 letters or digits.');
    }
    if (!VEHICLE_TYPES.includes(input.type)) {
      throw new ValidationError(`Vehicle type must be one of: ${VEHICLE_TYPES.join(', ')}.`);
    }
    const capacity = toInt(input.capacity, 'Capacity', 1, 100);
    if (s.vehicles.some((v) => v.regNo === regNo)) {
      throw new ValidationError(`Vehicle ${regNo} is already registered.`);
    }
    s.vehicles.push({ id: nextId(s, 'V'), regNo, type: input.type, capacity });
    return s;
  }

  function removeVehicle(state, vehicleId) {
    const s = clone(state);
    findById(s.vehicles, vehicleId, 'Vehicle');
    if (s.trips.some((t) => t.vehicleId === vehicleId)) {
      throw new ValidationError('This vehicle has trips. Delete its trips first.');
    }
    s.vehicles = s.vehicles.filter((v) => v.id !== vehicleId);
    return s;
  }

  // ---------- trips ----------

  function addTrip(state, input, now = Date.now()) {
    const s = clone(state);
    const route = findById(s.routes, input.routeId, 'Route');
    const vehicle = findById(s.vehicles, input.vehicleId, 'Vehicle');
    const departure = parseLocalDateTime(input.departure, 'Departure');
    if (departure <= now) throw new ValidationError('Departure must be in the future.');
    const arrival = departure + route.durationMin * 60000;
    const clash = s.trips.find(
      (t) => t.vehicleId === vehicle.id && departure < t.arrival && t.departure < arrival
    );
    if (clash) {
      throw new ValidationError(`Vehicle ${vehicle.regNo} is already on trip ${clash.id} during that time.`);
    }
    s.trips.push({ id: nextId(s, 'T'), routeId: route.id, vehicleId: vehicle.id, departure, arrival });
    return s;
  }

  function removeTrip(state, tripId) {
    const s = clone(state);
    findById(s.trips, tripId, 'Trip');
    if (seatsBooked(s, tripId) > 0) {
      throw new ValidationError('This trip has confirmed bookings. Cancel them first.');
    }
    s.trips = s.trips.filter((t) => t.id !== tripId);
    return s;
  }

  /** Upcoming trips that pass `from` before `to` (both optional), optionally on a given local date. */
  function searchTrips(state, query = {}, now = Date.now()) {
    const from = query.from ? cleanText(query.from, 'From') : '';
    const to = query.to ? cleanText(query.to, 'To') : '';
    if (from && to && key(from) === key(to)) throw new ValidationError('From and To must be different stops.');
    const date = query.date ? String(query.date).trim() : '';
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Date must be YYYY-MM-DD.');

    return state.trips
      .filter((trip) => trip.departure > now)
      .map((trip) => ({
        trip,
        route: findById(state.routes, trip.routeId, 'Route'),
        vehicle: findById(state.vehicles, trip.vehicleId, 'Vehicle'),
      }))
      .filter(({ trip, route }) => {
        const i = from ? stopIndex(route, from) : 0;
        const j = to ? stopIndex(route, to) : route.stops.length - 1;
        if (i < 0 || j < 0 || i >= j) return false;
        return !date || formatLocalDate(trip.departure) === date;
      })
      .map((r) => ({ ...r, seatsLeft: seatsLeft(state, r.trip) }))
      .sort((a, b) => a.trip.departure - b.trip.departure);
  }

  // ---------- bookings ----------

  function bookTicket(state, input, now = Date.now()) {
    const s = clone(state);
    const trip = findById(s.trips, input.tripId, 'Trip');
    if (trip.departure <= now) throw new ValidationError('This trip has already departed.');
    const route = findById(s.routes, trip.routeId, 'Route');
    const passengerName = cleanText(input.passengerName, 'Passenger name');
    const phone = String(input.phone ?? '').replace(/[\s-]/g, '');
    if (!/^\+?\d{7,15}$/.test(phone)) {
      throw new ValidationError('Phone must be 7-15 digits, optionally starting with +.');
    }
    const seats = toInt(input.seats, 'Seats', 1, MAX_SEATS_PER_BOOKING);

    const i = input.from ? stopIndex(route, String(input.from)) : 0;
    const j = input.to ? stopIndex(route, String(input.to)) : route.stops.length - 1;
    if (i < 0 || j < 0) throw new ValidationError(`Both stops must be on route "${route.name}".`);
    if (i >= j) throw new ValidationError('Boarding stop must come before the drop-off stop.');

    const left = seatsLeft(s, trip);
    if (left <= 0) throw new ValidationError('This trip is full.');
    if (seats > left) throw new ValidationError(`Only ${left} seat(s) left on this trip.`);

    s.bookings.push({
      id: nextId(s, 'B'),
      tripId: trip.id,
      passengerName,
      phone,
      seats,
      from: route.stops[i],
      to: route.stops[j],
      totalPaise: route.farePaise * seats,
      status: 'confirmed',
      createdAt: now,
    });
    return s;
  }

  function cancelBooking(state, bookingId, now = Date.now()) {
    const s = clone(state);
    const booking = findById(s.bookings, bookingId, 'Booking');
    if (booking.status !== 'confirmed') throw new ValidationError('This booking is already cancelled.');
    const trip = findById(s.trips, booking.tripId, 'Trip');
    if (trip.departure <= now) throw new ValidationError('A booking cannot be cancelled after departure.');
    booking.status = 'cancelled';
    booking.cancelledAt = now;
    return s;
  }

  return {
    ValidationError,
    VEHICLE_TYPES,
    MAX_SEATS_PER_BOOKING,
    emptyState,
    parseState,
    parseLocalDateTime,
    formatLocalDate,
    formatLocalDateTime,
    seatsLeft,
    addRoute,
    removeRoute,
    addVehicle,
    removeVehicle,
    addTrip,
    removeTrip,
    searchTrips,
    bookTicket,
    cancelBooking,
  };
});
