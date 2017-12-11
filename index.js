/**
 * Middleware service for handling NEM transactions on Chronobank platform
 * @module Chronobank/nem-blockprocessor
 * @requires config
 * @requires utils
 * @requires models/blockModel
 * @requires services/blockProcessService
 */

const _ = require('lodash'),
  Promise = require('bluebird'),
  mongoose = require('mongoose'),
  bunyan = require('bunyan'),
  amqp = require('amqplib'),
  config = require('./config'),
  utils = require('./utils'),
  blockModel = require('./models/blockModel'),
  log = bunyan.createLogger({name: 'nem-blockprocessor'}),
  blockProcessService = require('./services/blockProcessService');

mongoose.Promise = Promise;
mongoose.connect(config.mongo.uri, {useMongoClient: true});

const saveBlockHeight = currentBlock =>
  blockModel.findOneAndUpdate({network: config.nis.network}, {
    $set: {
      block: currentBlock,
      created: Date.now()
    }
  }, {upsert: true});

const init = async function () {
  let currentBlock = await blockModel.findOne({ network: config.nis.network }).sort('-block');
  currentBlock = _.chain(currentBlock).get('block', 0).add(0).value();
  log.info(`search from block:${currentBlock} for network:${config.nis.network}`);

  // Establishing RabbitMQ connection
  let amqpInstance = await amqp.connect(config.rabbit.url)
    .catch(() => {
      log.error('rabbitmq process has finished!');
      process.exit(0);
    });

  let channel = await amqpInstance.createChannel();

  channel.on('close', () => {
    log.error('rabbitmq process has finished!');
    process.exit(0);
  });

  await channel.assertExchange('events', 'topic', {durable: false});

  /**
   * Recursive routine for processing incoming blocks.
   * @return {undefined}
   */
  let processBlock = async () => {
    try {
      let filteredTxs = await Promise.resolve(blockProcessService(currentBlock)).timeout(20000);
      console.log(currentBlock, filteredTxs.length);

      for (let tx of filteredTxs) {
        let addresses = [tx.recipient, utils.toAddress(tx.signer, tx.version >> 24)];
        for(let address of addresses){
          console.log('publishing: ',`${config.rabbit.serviceName}_transaction.${address}`);
          await channel.publish('events', `${config.rabbit.serviceName}_transaction.${address}`, new Buffer(JSON.stringify(tx)));
        }
      }

      await saveBlockHeight(currentBlock);
      
      currentBlock++;
      processBlock();
    } catch (err) 
    {
      if(err instanceof Promise.TimeoutError)
        return processBlock();

      if(_.get(err, 'code') === 0) {
        log.info(`await for next block ${currentBlock}`);
        return setTimeout(processBlock, 10000);
      }

      if(_.get(err, 'code') === 2) {
        await saveBlockHeight(currentBlock);
      }

      currentBlock++;
      processBlock();
    }
  };

  processBlock();
};
module.exports = init();