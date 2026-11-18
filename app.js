/* Transport System - browser UI. All user text is rendered with textContent (no innerHTML). */
(function () {
  'use strict';

  const T = window.Transport;
  const STORAGE_KEY = 'transport-system:v1';
  const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const $ = (id) => document.getElementById(id);

  let startupWarning = '';
  let state = loadState();
  let lastSearch = null; // { from, to, date } of the most recent successful search

  // ---------- storage ----------

  function loadState() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      startupWarning = 'Browser storage is blocked. Data will be lost when you close this tab.';
      return T.emptyState();
    }
    try {
      return T.parseState(raw);
    } catch {
      try { localStorage.setItem(STORAGE_KEY + ':backup', raw); } catch { /* nothing more we can do */ }
      startupWarning = `Saved data was unreadable, so the app started empty. A copy was kept under "${STORAGE_KEY}:backup".`;
      return T.emptyState();
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  }

  // ---------- feedback ----------

  function notify(message, isError = false) {
    const el = $('status');
    el.textContent = message;
    el.className = 'status ' + (isError ? 'error' : 'ok');
  }

  function handleError(err) {
    if (err instanceof T.ValidationError) {
      notify(err.message, true);
    } else {
      console.error(err);
      notify('Something went wrong. Reload the page and try again.', true);
    }
  }

  /** Runs a pure state change; commits it only if it succeeds. */
  function apply(mutate, message) {
    try {
      state = mutate(state);
    } catch (err) {
      handleError(err);
      return false;
    }
    const saved = persist();
    renderAll();
    const text = typeof message === 'function' ? message(state) : message;
    notify(saved ? text : `${text} Warning: could not save to browser storage.`, !saved);
    return true;
  }

  // ---------- DOM helpers ----------

  function cell(content) {
    const td = document.createElement('td');
    if (content instanceof Node) td.append(content);
    else td.textContent = String(content);
    return td;
  }

  function actionButton(label, ariaLabel, onClick, className = 'secondary') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', onClick);
    return b;
  }

  function fillTable(tbodyId, rows, emptyText, columns) {
    const tbody = $(tbodyId);
    tbody.replaceChildren();
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = cell(emptyText);
      td.colSpan = columns;
      td.className = 'empty';
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const values of rows) {
      const tr = document.createElement('tr');
      values.forEach((v) => tr.append(cell(v)));
      tbody.append(tr);
    }
  }

  function fillSelect(selectId, options, placeholder) {
    const select = $(selectId);
    const previous = select.value;
    select.replaceChildren();
    const first = new Option(options.length ? placeholder : 'None available', '');
    select.append(first);
    for (const { value, label } of options) select.append(new Option(label, value));
    if (options.some((o) => o.value === previous)) select.value = previous;
  }

  const routeOf = (trip) => state.routes.find((r) => r.id === trip.routeId);
  const vehicleOf = (trip) => state.vehicles.find((v) => v.id === trip.vehicleId);

  // ---------- rendering ----------

  function renderRoutes() {
    fillTable('route-rows', state.routes.map((r) => [
      r.id, r.name, r.stops.join(' → '), `${r.durationMin} min`, money.format(r.farePaise / 100),
      actionButton('Delete', `Delete route ${r.name}`, () => {
        if (confirm(`Delete route "${r.name}"?`)) apply((s) => T.removeRoute(s, r.id), `Route "${r.name}" deleted.`);
      }, 'danger'),
    ]), 'No routes yet.', 6);

    const stops = new Set(state.routes.flatMap((r) => r.stops));
    $('stop-list').replaceChildren(...[...stops].sort().map((s) => new Option(s)));
  }

  function renderVehicles() {
    fillTable('vehicle-rows', state.vehicles.map((v) => [
      v.id, v.regNo, v.type, v.capacity,
      actionButton('Delete', `Delete vehicle ${v.regNo}`, () => {
        if (confirm(`Delete vehicle ${v.regNo}?`)) apply((s) => T.removeVehicle(s, v.id), `Vehicle ${v.regNo} deleted.`);
      }, 'danger'),
    ]), 'No vehicles yet.', 5);
  }

  function renderTrips() {
    fillSelect('trip-route', state.routes.map((r) => ({ value: r.id, label: `${r.name} (${r.id})` })), 'Choose a route');
    fillSelect('trip-vehicle', state.vehicles.map((v) => ({ value: v.id, label: `${v.regNo} · ${v.type} · ${v.capacity} seats` })), 'Choose a vehicle');
    $('trip-departure').min = T.formatLocalDateTime(Date.now());

    const trips = [...state.trips].sort((a, b) => a.departure - b.departure);
    fillTable('trip-rows', trips.map((t) => [
      t.id, routeOf(t).name, when.format(t.departure), when.format(t.arrival), vehicleOf(t).regNo,
      T.seatsLeft(state, t),
      actionButton('Delete', `Delete trip ${t.id}`, () => {
        if (confirm(`Delete trip ${t.id}?`)) apply((s) => T.removeTrip(s, t.id), `Trip ${t.id} deleted.`);
      }, 'danger'),
    ]), 'No trips scheduled.', 7);
  }

  function renderSearch() {
    let results = [];
    if (lastSearch) {
      try {
        results = T.searchTrips(state, lastSearch, Date.now());
      } catch (err) {
        handleError(err);
      }
    }
    fillTable('search-results', results.map(({ trip, route, vehicle, seatsLeft }) => [
      trip.id, route.name, when.format(trip.departure), `${vehicle.regNo} (${vehicle.type})`, seatsLeft,
      money.format(route.farePaise / 100),
      seatsLeft > 0
        ? actionButton('Select', `Select trip ${trip.id}`, () => {
          $('booking-trip').value = trip.id;
          $('passenger-name').focus();
        })
        : 'Full',
    ]), lastSearch ? 'No upcoming trips match. Try another stop or date.' : 'Search to see available trips.', 7);

    fillSelect('booking-trip', results.filter((r) => r.seatsLeft > 0).map(({ trip, route }) => ({
      value: trip.id, label: `${trip.id} · ${route.name} · ${when.format(trip.departure)}`,
    })), 'Choose a trip from the results');
  }

  function renderBookings() {
    const bookings = [...state.bookings].reverse(); // newest first
    fillTable('booking-rows', bookings.map((b) => {
      const trip = state.trips.find((t) => t.id === b.tripId);
      const upcoming = trip && trip.departure > Date.now();
      return [
        b.id, b.passengerName, b.phone,
        trip ? `${trip.id} · ${when.format(trip.departure)}` : b.tripId,
        `${b.from} → ${b.to}`, b.seats, money.format(b.totalPaise / 100), b.status,
        b.status === 'confirmed' && upcoming
          ? actionButton('Cancel', `Cancel booking ${b.id}`, () => {
            if (confirm(`Cancel booking ${b.id} for ${b.passengerName}?`)) {
              apply((s) => T.cancelBooking(s, b.id, Date.now()), `Booking ${b.id} cancelled.`);
            }
          }, 'danger')
          : '',
      ];
    }), 'No bookings yet.', 9);
  }

  function renderAll() {
    renderRoutes();
    renderVehicles();
    renderTrips();
    renderSearch();
    renderBookings();
  }

  // ---------- forms ----------

  const formData = (form) => Object.fromEntries(new FormData(form));

  function onSubmit(formId, handler) {
    $(formId).addEventListener('submit', (e) => {
      e.preventDefault();
      if (handler(formData(e.target))) e.target.reset();
    });
  }

  onSubmit('route-form', (d) => apply((s) => T.addRoute(s, d), (s) => `Route "${s.routes.at(-1).name}" added.`));
  onSubmit('vehicle-form', (d) => apply((s) => T.addVehicle(s, d), (s) => `Vehicle ${s.vehicles.at(-1).regNo} added.`));
  onSubmit('trip-form', (d) => apply((s) => T.addTrip(s, d, Date.now()), (s) => `Trip ${s.trips.at(-1).id} scheduled.`));

  onSubmit('booking-form', (d) => {
    if (!d.tripId) {
      notify('Search, then choose a trip before booking.', true);
      return false;
    }
    const input = { ...d, from: lastSearch?.from, to: lastSearch?.to };
    return apply((s) => T.bookTicket(s, input, Date.now()), (s) => {
      const b = s.bookings.at(-1);
      return `Booked ${b.id}: ${b.seats} seat(s), ${b.from} → ${b.to}, total ${money.format(b.totalPaise / 100)}.`;
    });
  });

  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const query = formData(e.target);
    try {
      const count = T.searchTrips(state, query, Date.now()).length;
      lastSearch = query;
      renderSearch();
      notify(count ? `${count} trip(s) found.` : 'No upcoming trips match. Try another stop or date.', !count);
    } catch (err) {
      handleError(err);
    }
  });

  // ---------- data buttons ----------

  $('seed-btn').addEventListener('click', () => {
    if (state.routes.length || state.vehicles.length) {
      notify('Sample data can only be loaded into an empty app. Delete all data first.', true);
      return;
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const at = (h, m = 0) => {
      const d = new Date(tomorrow);
      d.setHours(h, m, 0, 0);
      return T.formatLocalDateTime(d.getTime());
    };
    apply((s0) => {
      let s = T.addRoute(s0, { name: 'City Line 1', stops: 'Central Station, Market Square, University, Airport', durationMin: 75, fare: '60' });
      s = T.addRoute(s, { name: 'Express 2', stops: 'Bus Depot, Tech Park, Airport', durationMin: 45, fare: '85.50' });
      s = T.addVehicle(s, { regNo: 'KA01AB1234', type: 'Bus', capacity: 40 });
      s = T.addVehicle(s, { regNo: 'KA01CD5678', type: 'Mini bus', capacity: 20 });
      const [r1, r2] = s.routes;
      const [v1, v2] = s.vehicles;
      s = T.addTrip(s, { routeId: r1.id, vehicleId: v1.id, departure: at(8) });
      s = T.addTrip(s, { routeId: r1.id, vehicleId: v1.id, departure: at(10) });
      s = T.addTrip(s, { routeId: r2.id, vehicleId: v2.id, departure: at(9, 30) });
      return s;
    }, 'Sample data loaded: 2 routes, 2 vehicles, 3 trips tomorrow.');
  });

  $('reset-btn').addEventListener('click', () => {
    if (!confirm('Delete ALL routes, vehicles, trips and bookings? This cannot be undone.')) return;
    lastSearch = null;
    apply(() => T.emptyState(), 'All data deleted.');
  });

  // ---------- start ----------

  fillSelect('vehicle-type', T.VEHICLE_TYPES.map((t) => ({ value: t, label: t })), 'Choose a type');
  $('vehicle-type').options[1].defaultSelected = true; // survives form.reset()
  renderAll();
  if (startupWarning) notify(startupWarning, true);
})();
