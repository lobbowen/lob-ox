'use strict';

const hub = require('../../platform/service/log/hub');

const SOURCES = [
  { name: 'guard', key: 'guard', local: true },
  { name: 'router-daemon', key: 'router' },
  { name: 'lan-daemon', key: 'lan' },
];

const INTERNAL_TYPES = ['router_daemon_supervised', 'orphan_audit'];

hub.setSources(SOURCES);
hub.setInternalTypes(INTERNAL_TYPES);
