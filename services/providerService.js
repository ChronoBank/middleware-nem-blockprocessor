/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const bunyan = require('bunyan'),
  config = require('../config'),
  Api = require('../utils/api/Api'),
  sem = require('semaphore')(1),
  providerServiceInterface = require('middleware-common-components/interfaces/blockProcessor/providerServiceInterface'),
  Promise = require('bluebird'),
  EventEmitter = require('events'),
  log = bunyan.createLogger({name: 'app.services.providerService', level: config.logs.level});

/**
 * @service
 * @description the service for handling connection to node
 * @returns Object<ProviderService>
 */

class ProviderService extends EventEmitter{

  constructor () {
    super();
    this.connector = null;

    if (config.node.providers.length > 1)
      this.findBestNodeInterval = setInterval(() => {
        this.switchConnectorSafe();
      }, 60000 * 5);
  }

  /** @function
   * @description reset the current connection
   * @return {Promise<void>}
   */
  async resetConnector () {
    this.switchConnector();
    this.emit('disconnected');
  }

  /**
   * @function
   * @description choose the connector
   * @return {Promise<null|*>}
   */
  async switchConnector () {

    const providerURI = await Promise.any(config.node.providers.map(async providerURI => {

      const apiProvider = new Api(providerURI);

      try {
        await Promise.resolve(apiProvider.openWSProvider()).timeout(20000);
        apiProvider.wsProvider.disconnect();
      } catch (err) {
        apiProvider.wsProvider.disconnect();
        throw new Error(err);
      }

      await apiProvider.heartbeat();
      return providerURI;
    })).catch(() => {
      log.error('no available connection!');
      process.exit(0);
    });

    if (this.connector && this.connector.http === providerURI.http)
      return;

    this.emit('provider_set', providerURI);

    this.connector = new Api(providerURI);
    this.connector.on('disconnect', () => this.resetConnector());

    this.pingIntervalId = setInterval(async () => {

      const isConnected = await this.connector.heartbeat().catch(() => false);

      if (isConnected === false) {
        clearInterval(this.pingIntervalId);
        this.resetConnector();
      }
    }, 5000);

    await this.connector.openWSProvider();

    this.connector.wsProvider.subscribe('/unconfirmed', (message) => {
      this.emit('unconfirmedTx', JSON.parse(message.body));
    });

    return this.connector;

  }

  /**
   * @function
   * @description safe connector switching, by moving requests to
   * @return {Promise<bluebird>}
   */
  async switchConnectorSafe () {

    return new Promise(res => {
      sem.take(async () => {
        await this.switchConnector();
        res(this.connector);
        sem.leave();
      });
    });
  }

  /**
   * @function
   * @description
   * @return {Promise<*|bluebird>}
   */
  async get () {
    return this.connector || await this.switchConnectorSafe();
  }

}

module.exports = providerServiceInterface(new ProviderService());
