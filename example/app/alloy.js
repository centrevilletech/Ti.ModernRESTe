// RESTe has to be configured before any view that binds to its collections is created, so it happens here.
Alloy.Globals.api = require('api').create();
