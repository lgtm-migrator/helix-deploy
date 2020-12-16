/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const Fastly = require('@adobe/fastly-native-promises');

class FastlyGateway {
  constructor(builder) {
    this._builder = builder;
    this._service = undefined;
    this._auth = undefined;
    this._fastly = null;
    this._deployers = [];
    this._checkpath = '';
  }

  ready() {
    return !!this._service && !!this._auth && !!this._checkpath;
  }

  init() {
    if (this.ready() && !this._fastly) {
      this._fastly = Fastly(this._auth, this._service);
    }
  }

  withAuth(value) {
    this._auth = value;
    return this;
  }

  withServiceID(value) {
    this._service = value;
    return this;
  }

  withDeployer(value) {
    this._deployers.push(value);
    return this;
  }

  withCheckpath(value) {
    this._checkpath = value;
    return this;
  }

  get log() {
    return this._builder.log;
  }

  selectBackendVCL() {
    const vcl = `
      declare local var.i INTEGER;
      set var.i = randomint(0, ${this._deployers.length - 1});

      if (1 == 0) {}`;

    const middle = this._deployers.map((deployer, i) => `if(var.i <= ${i} && backend.F_${deployer.constructor.name.replace('Deployer', '')}.healthy) {
      set req.backend = F_${deployer.constructor.name.replace('Deployer', '')};
    }`);

    const fallback = `{
      set req.backend = F_${this._deployers[0].constructor.name.replace('Deployer', '')};
      ${this._deployers[0].customVCL}
    }`;

    return [vcl, ...middle, fallback].join(' else ');
  }

  setURLVCL() {
    return this._deployers.map((deployer) => `
      if (req.backend == F_${deployer.constructor.name.replace('Deployer', '')}) {
        set bereq.url = "${deployer.baseURL}" + req.url;
      }
      `).join('\n');
  }

  async deploy() {
    this.log.info('Set up Fastly Gateway');

    await this._fastly.transact(async (newversion) => {
      // set up health checks
      await Promise.all(this._deployers
        .map((deployer) => ({
          check_interval: 60000,
          expected_response: 200,
          host: deployer.host,
          http_version: '1.1',
          initial: 1,
          name: deployer.constructor.name.replace('Deployer', 'Check'),
          path: deployer.baseURL + this._checkpath,
          threshold: 1,
          timeout: 5000,
          window: 2,
        }))
        .map((healthcheck) => this._fastly
          .writeHealthcheck(newversion, healthcheck.name, healthcheck)));

      // set up backends
      await Promise.all(this._deployers
        .map((deployer) => ({
          hostname: deployer.host,
          ssl_cert_hostname: deployer.host,
          ssl_sni_hostname: deployer.host,
          address: deployer.host,
          name: deployer.constructor.name.replace('Deployer', ''),
          healthcheck: deployer.constructor.name.replace('Deployer', 'Check'),
          error_threshold: 0,
          first_byte_timeout: 60000,
          weight: 100,
          connect_timeout: 5000,
          port: 443,
          between_bytes_timeout: 10000,
          shield: 'bwi-va-us',
          max_conn: 200,
          use_ssl: true,
        }))
        .map((backend) => this._fastly
          .writeBackend(newversion, backend.name, backend)));

      await this._fastly.writeSnippet(newversion, {
        name: 'Select Backend',
        priority: 10,
        type: 'recv',
        content: this.selectBackendVCL(),
      });

      await this._fastly.writeSnippet(newversion, {
        name: 'Set URL in MISS',
        priority: 10,
        type: 'miss',
        content: this.setURLVCL(),
      });

      await this._fastly.writeSnippet(newversion, {
        name: 'Set URL in PASS',
        priority: 10,
        type: 'miss',
        content: this.setURLVCL(),
      });
    }, true);
  }
}

module.exports = FastlyGateway;
