/** 
* Copyright 2017–2018, LaborX PTY
* Licensed under the AGPL Version 3 license.
* @author Kirill Sergeev <cloudkserg11@gmail.com>
*/
const bunyan = require('bunyan'),
  _ = require('lodash'),
  Promise = require('bluebird'),
  models = require('../models'),
  getBlock = require('../utils/blocks/getBlock'),
  addBlock = require('../utils/blocks/addBlock'),
  EventEmitter = require('events'),
  providerService = require('../services/providerService'),
  syncCacheServiceInterface = require('middleware-common-components/interfaces/blockProcessor/syncCacheServiceInterface'),
  allocateBlockBuckets = require('../utils/blocks/allocateBlockBuckets'),
  config = require('../config'),
  log = bunyan.createLogger({name: 'shared.services.syncCacheService', level: config.logs.level});

/**
 * @service
 * @description sync the blockchain history
 * @returns {Promise.<*>}
 */

class SyncCacheService extends EventEmitter{

  constructor () {
    super();
  }

  /** @function
   * @description start syncing process
   * @return {Promise<*>}
   */
  async start () {
    await this.indexCollection();
    let data = await allocateBlockBuckets();
    this.doJob(data.missedBuckets);
    return data.height;
  }

  /**
   * @function
   * @description index all collections in mongo
   * @return {Promise<void>}
   */
  async indexCollection () {
    log.info('indexing...');
    await models.blockModel.init();
    await models.accountModel.init();
    await models.txModel.init();
    log.info('indexation completed!');
  }

  /**
   * @function
   * @description process the buckets
   * @param buckets - array of blocks
   * @return {Promise<void>}
   */
  async doJob (buckets) {

    while (buckets.length)
      try {
        for (let bucket of buckets) {

          if (bucket.length === 2 && bucket.length !== (_.last(bucket) > bucket[0] ? _.last(bucket) - bucket[0] : bucket[0] - _.last(bucket)) + 1) {

            let blocksToProcess = [];
            for (let blockNumber = _.last(bucket); blockNumber >= bucket[0]; blockNumber--)
              blocksToProcess.push(blockNumber);

            _.pullAll(bucket, bucket);
            bucket.push(...blocksToProcess);
          }

          await this.runPeer(bucket);
          if (!bucket.length)
            _.pull(buckets, bucket);
        }

        this.emit('end');

      } catch (err) {
        log.error(err);
      }
  }

  /**
   * @function
   * @description process the bucket
   * @param bucket
   * @return {Promise<*>}
   */
  async runPeer (bucket) {

    let apiProvider = await providerService.get();
    let lastBlock = await apiProvider.getBlockByNumber(_.last(bucket));

    if (!lastBlock || (_.last(bucket) !== 0 && !lastBlock.number))
      return await Promise.delay(10000);

    log.info(`nem provider took chuck of blocks ${bucket[0]} - ${_.last(bucket)}`);

    await Promise.mapSeries(bucket, async (blockNumber) => {
      let block = await getBlock(blockNumber);
      await addBlock(block);
      _.pull(bucket, blockNumber);
      this.emit('block', block);
    });
  }
}

module.exports = function (...args) {
  return syncCacheServiceInterface(new SyncCacheService(...args));
};