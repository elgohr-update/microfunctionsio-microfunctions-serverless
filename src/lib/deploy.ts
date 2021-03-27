import _ = require('lodash');
import BbPromise = require('bluebird');
const Api = require('kubernetes-client');
import { Crd } from './crd';

import moment = require('moment');
import url = require('url');
import {
  checkFinished,
  getConnectionOptions,
  getDeployableItemsNumber,
  getKubernetesAPIURL,
  loadKubeConfig,
  setExponentialInterval,
} from './helpers';

/** Supported message queue types */
const MQTypes = Object.freeze({ kafka: 'Kafka', nats: 'NATS' });

function forceString(obj) {
  const result = {};
  _.each(obj, (v, k) => {
    if (v === null) {
      result[k] = 'null';
    } else if (v === undefined) {
      result[k] = 'undefined';
    } else if (typeof v === 'object') {
      result[k] = JSON.stringify(v);
    } else {
      result[k] = v.toString();
    }
  });
  return result;
}

function parseEnv(src) {
  let res = [];
  if (_.isPlainObject(src)) {
    _.each(src, (v, k) => {
      res.push({ name: k, value: v.toString() });
    });
  } else if (_.isArray(src)) {
    res = _.cloneDeep(src);
  } else {
    throw new Error(
      'Format of \'environment\' is unknown: neither dictionary(object) nor array.',
    );
  }
  return res;
}

function getFunctionDescription(
  funcName,
  namespace,
  runtime,
  image,
  deps,
  funcContent,
  contentType,
  checksum,
  handler,
  desc,
  labels,
  annotations,
  env,
  memory,
  timeout,
  port,
  servicePort,
  secrets,
  cpu,
  affinity,
  tolerations,
  volumes,
  volumeMounts,
  replicas,
) {
  const funcs: any = {
    apiVersion: 'kubeless.io/v1beta1',
    kind: 'Function',
    metadata: {
      name: funcName,
      namespace,
      labels: forceString(_.assign({}, labels, {
        'created-by': 'kubeless',
        'function': funcName,
      })),
      annotations: annotations || {},
    },
    spec: {
      'deps': deps || '',
      'function': funcContent,
      checksum,
      'function-content-type': contentType,
      handler,
      runtime,
      'timeout': String(timeout || '180'),
      'service': {
        ports: [{
          name: 'http-function-port',
          port: Number(servicePort || port || 8080),
          protocol: 'TCP',
          targetPort: Number(port || 8080),
        }],
        selector: {
          function: funcName,
        },
        type: 'ClusterIP',
      },
    },
  };
  if (desc) {
    funcs.metadata.annotations['kubeless.serverless.com/description'] = desc;
  }

  if (image || env || memory || secrets || cpu || affinity || tolerations || volumes) {
    const container: any = {
      name: funcName,
    };
    if (image) {
      container.image = image;
    }
    if (env) {
      container.env = parseEnv(env);
    }
    if (memory || cpu) {
      container.resources = { limits: {}, requests: {} };
      if (memory) {
        // If no suffix is given we assume the unit will be `Mi`
        const memoryWithSuffix = memory.toString().match(/\d+$/) ?
          `${memory}Mi` :
          memory;
        container.resources.limits.memory = memoryWithSuffix;
        container.resources.requests.memory = memoryWithSuffix;
      }
      if (cpu) {
        container.resources.limits.cpu = cpu;
        container.resources.requests.cpu = cpu;
      }
    }
    funcs.spec.deployment = {
      spec: {
        replicas,
        template: {
          spec: {
            containers: [container],
          },
        },
      },
    };

    // convert secretes to volumes and volume mounts
    if (secrets !== undefined && secrets.length > 0) {
      if (volumes === undefined) {
        // eslint-disable-next-line no-param-reassign
        volumes = [];
      }
      if (volumeMounts === undefined) {
        // eslint-disable-next-line no-param-reassign
        volumeMounts = [];
      }
      secrets.forEach(secret => {
        volumes.push({
          name: `${secret}-vol`,
          secret: { secretName: secret },
        });
        volumeMounts.push({
          mountPath: `/${secret}`,
          name: `${secret}-vol`,
        });
      });
    }

    if (volumes !== undefined && volumes.length > 0) {
      funcs.spec.deployment.spec.template.spec.volumes = volumes;
    }

    if (volumeMounts !== undefined && volumeMounts.length > 0) {
      container.volumeMounts = volumeMounts;
    }

    if (affinity) {
      funcs.spec.deployment.spec.template.spec.affinity = affinity;
    }
    if (tolerations) {
      funcs.spec.deployment.spec.tolerations = tolerations;
    }
  }
  return funcs;
}

function waitForDeployment(funcName, requestMoment, namespace, options, kubeConfig) {
  const opts = _.defaults({}, options, {
    verbose: false,
    log: console.log,
  });
  const core = new Api.Core(getConnectionOptions(
    loadKubeConfig(kubeConfig), { namespace }),
  );
  let retries = 0;
  let successfulCount = 0;
  let previousPodStatus = '';
  return new BbPromise((resolve, reject) => {
    const loop = setExponentialInterval(() => {
      if (retries > 30) {
        opts.log(
          `Giving up, unable to retrieve the status of the ${funcName} deployment. `,
        );
        loop.clearInterval();
        reject(`Unable to retrieve the status of the ${funcName} deployment`);
      }
      let runningPods = 0;
      core.ns.pods.get((err, podsInfo) => {
        if (err) {
          if (err.message.match(/request timed out/)) {
            opts.log('Request timed out. Retrying...');
          } else {
            throw err;
          }
        } else {
          // Get the pods for the current function
          const functionPods = _.filter(
            podsInfo.items,
            (pod) => (
              !_.isEmpty(pod.metadata.labels) &&
              pod.metadata.labels.function === funcName &&
              !pod.metadata.deletionTimestamp
            ),
          );
          if (_.isEmpty(functionPods)) {
            retries++;
            opts.log(`Unable to find any running pod for ${funcName}. Retrying...`);
          } else {
            _.each(functionPods, pod => {
              // We assume that the function pods will only have one container
              if (pod.status.containerStatuses) {
                if (pod.status.containerStatuses[0].ready) {
                  runningPods++;
                } else if (pod.status.containerStatuses[0].restartCount > 2) {
                  opts.log('ERROR: Failed to deploy the function');
                  process.exitCode = process.exitCode || 1;
                  loop.clearInterval();
                }
              }
            });
            if (runningPods === functionPods.length) {
              // The pods may be running for a short time
              // so we should ensure that they are stable
              successfulCount++;
              if (successfulCount >= 2) {
                // The pod is running successfully. Check if the function service is ready
                core.ns.services.get((svcErr, svcsInfo) => {
                  if (svcErr) {
                    if (svcErr.message.match(/request timed out/)) {
                      opts.log('Request timed out. Retrying...');
                    } else {
                      throw svcErr;
                    }
                  } else {
                    // Get the svc for current function
                    const functionSvcs = _.filter(
                      svcsInfo.items,
                      (svc) => (
                        !_.isEmpty(svc.metadata.labels) &&
                        svc.metadata.labels.function === funcName &&
                        !svc.metadata.deletionTimestamp
                      ),
                    );
                    if (_.isEmpty(functionSvcs)) {
                      retries++;
                      opts.log(`Unable to find internal service for ${funcName}. Retrying...`);
                    } else {
                      opts.log(`Function ${funcName} successfully deployed`);
                      loop.clearInterval();
                      resolve();
                    }
                  }
                });
              }
            } else if (opts.verbose) {
              successfulCount = 0;
              const currentPodStatus = _.map(functionPods, p => (
                p.status.containerStatuses ?
                  JSON.stringify(p.status.containerStatuses[0].state) :
                  'unknown'
              ));
              if (!_.isEqual(previousPodStatus, currentPodStatus)) {
                opts.log(`Pods status: ${currentPodStatus}`);
                previousPodStatus = currentPodStatus;
              }
            } else if (process.exitCode === 1) {
              reject('Failed to deploy some functions');
            }
          }
        }
      });
    }, 2000, 30000);
  });
}

function deployFunctionAndWait(body, functions, options, kubconfig) {
  const opts = _.defaults({}, options, {
    verbose: false,
    log: console.log,
  });
  const requestMoment = moment().milliseconds(0);
  opts.log(`Deploying function ${body.metadata.name}...`);
  return new BbPromise((resolve, reject) => {
    functions.post({ body })
      .catch(err => {
        reject(new Error(
          `Unable to deploy the function ${body.metadata.name}. Received:\n` +
          `  Code: ${err.code}\n` +
          `  Message: ${err.message}`));
      }).then((res) => {
      if (res && res.code && res.code === 409) {
        opts.log(
          `The function ${body.metadata.name} already exists. ` +
          'Redeploy it usign --force or executing ' +
          `"sls deploy function -f ${body.metadata.name}".`,
        );
        resolve(false);
      } else if (res && res.code && res.code !== 200) {
        reject(new Error(
          `Unable to deploy the function ${body.metadata.name}. Received:\n` +
          `  Code: ${res.code}\n` +
          `  Message: ${res.message}`));
      } else {
        waitForDeployment(
          body.metadata.name,
          requestMoment,
          functions.namespace,
          { verbose: opts.verbose, log: opts.log }, kubconfig,
        ).catch((waitErr) => {
          reject(waitErr);
        }).then(() => {
          resolve(true);
        });
      }
    });
  });
}

function redeployFunctionAndWait(body, functions, options, kubconfig) {
  const opts = _.defaults({}, options, {
    verbose: false,
  });
  const requestMoment = moment().milliseconds(0);
  return new BbPromise((resolve, reject) => {
    functions.put(body.metadata.name, { body }).catch((err) => reject(new Error(
      `Unable to update the function ${body.metadata.name}. Received:\n` +
      `  Code: ${err.code}\n` +
      `  Message: ${err.message}`,
    ))).then((res) => {
      if (res.code && res.code !== 200) {
        reject(new Error(
          `Unable to update the function ${body.metadata.name}. Received:\n` +
          `  Code: ${res.code}\n` +
          `  Message: ${res.message}`));
      } else {
        waitForDeployment(
          body.metadata.name,
          requestMoment,
          functions.namespace,
          { verbose: opts.verbose, log: opts.log }, kubconfig,
        ).then(() => {
          resolve(true);
        });
      }
    });
  });
}

/**
 * Handling Kafka and NATS message queue trigger
 *
 * @param {MQTypes} mqType
 * @param {string} name
 * @param {string} namespace
 * @param {string} topic
 * @param {object} options
 */
function deployMQTrigger(mqType, name, namespace, topic, options, kubconfig) {
  const opts = _.defaults({}, options, {
    log: console.log,
  });
  const trigger = {
    apiVersion: 'kubeless.io/v1beta1',
    kind: `${mqType}Trigger`,
    metadata: {
      name: _.kebabCase(`${name}-${topic}`),
      namespace,
      labels: Object.assign(
        { 'created-by': 'kubeless' },
        options.labels,
      ),
    },
    spec: {
      functionSelector: {
        matchLabels: {
          'created-by': 'kubeless',
          'function': name,
        },
      },
      topic,
    },
  };
  const triggerApi = new Crd(
    'apis/kubeless.io',
    'v1beta1',
    namespace,
    `${mqType.toLowerCase()}triggers`, kubconfig,
  );
  opts.log(`Deploying ${mqType} trigger: ${trigger.metadata.name}`);
  return triggerApi.getItem(trigger.metadata.name)
    .then((res) => {
      if (res.code === 404) {
        return triggerApi.post({ body: trigger });
      }
      opts.log(`Updating existing ${mqType} trigger`);
      return triggerApi.put(trigger.metadata.name, { body: trigger });
    });
}

function deployScheduleTrigger(name, namespace, schedule, options, kubconfig) {
  const trigger = {
    apiVersion: 'kubeless.io/v1beta1',
    kind: 'CronJobTrigger',
    metadata: {
      name,
      namespace,
      labels: Object.assign(
        { 'created-by': 'kubeless' },
        options.labels,
      ),
    },
    spec: {
      'function-name': name,
      schedule,
    },
  };
  const scheduleTriggerApi = new Crd('apis/kubeless.io', 'v1beta1', namespace, 'cronjobtriggers', kubconfig);
  options.log(`Creating scheduled trigger for: ${trigger.metadata.name}`);
  return scheduleTriggerApi.getItem(trigger.metadata.name)
    .then((res) => {
      if (res.code === 404) {
        return scheduleTriggerApi.post({ body: trigger });
      }
      options.log('Updating existing schedule');
      return scheduleTriggerApi.put(trigger.metadata.name, { body: trigger });
    });
}

function deployHttpTrigger(name, namespace, path, options, kubconfig) {
  if (options.ingress.enableTlsAcme && options.ingress.tlsSecretName) {
    throw new Error('Cannot specify both enableTlsAcme and tlsSecretName');
  }
  // fix for issue https://github.com/kubeless/kubeless/issues/1124
  const baseAnnotations = {
    'kubernetes.io/ingress.class': options.ingress.class || 'nginx',
  };
  // end fix
  const trigger = {
    apiVersion: 'kubeless.io/v1beta1',
    kind: 'HTTPTrigger',
    metadata: {
      name,
      namespace,
      labels: Object.assign(
        { 'created-by': 'kubeless' },
        options.labels,
      ),
      annotations: Object.assign(baseAnnotations, options.ingress.additionalAnnotations),
    },
    spec: {
      'basic-auth-secret': options.ingress.basicAuthSecretName || '',
      'cors-enable': options.ingress.cors || false,
      'function-name': name,
      'gateway': options.ingress.class || 'nginx',  // not working: https://github.com/kubeless/kubeless/issues/1124
      'host-name': options.hostname,
      'path': path.replace(/^\//, ''),
      'tls': options.ingress.enableTlsAcme || false,
      'tls-secret': options.ingress.tlsSecretName || '',
    },
  };
  const httpTriggerApi = new Crd('apis/kubeless.io', 'v1beta1', namespace, 'httptriggers', kubconfig);
  options.log(`Creating http trigger for: ${trigger.metadata.name}`);
  return httpTriggerApi.getItem(trigger.metadata.name)
    .then((res) => {
      if (res.code === 404) {
        return httpTriggerApi.post({ body: trigger });
      }
      options.log('Updating existing http trigger');
      return httpTriggerApi.put(trigger.metadata.name, { body: trigger });
    });
}

function deployFunction(f, namespace, runtime, contentType, options, kubconfig) {

  const functionsApi = new Crd('apis/kubeless.io', 'v1beta1', namespace, 'functions', kubconfig);
  let environment = options.environment ? parseEnv(options.environment) : null;
  if (f.environment) {
    const fenv = parseEnv(f.environment);
    environment = environment ? environment.concat(fenv) : fenv;
  }
  const funcs = getFunctionDescription(
    f.id,
    namespace,
    f.runtime || runtime,
    f.image,
    f.deps,
    f.content,
    contentType,
    f.checksum,
    f.handler,
    f.description,
    f.labels,
    f.annotations,
    environment,
    f.memorySize || options.memorySize,
    f.timeout || options.timeout,
    f.port,
    f.servicePort,
    f.secrets,
    f.cpu || options.cpu,
    f.affinity || options.affinity,
    f.tolerations || options.tolerations,
    f.volumes || options.volumes,
    f.volumeMounts || options.volumeMounts,
     options.replicas,
  );

  return functionsApi.getItem(funcs.metadata.name).then((res) => {
    if (res.code === 404) {
      return deployFunctionAndWait(
        funcs,
        functionsApi,
        { verbose: options.verbose, log: options.log }, kubconfig,
      );
    }

    // The function already exits but with a different content
    return redeployFunctionAndWait(
      funcs,
      functionsApi,
      { verbose: options.verbose, log: options.log }, kubconfig,
    );
  });
}

/**
 * Handle message queue trigger input to normalize the users input values.
 *
 * @param {string|object} trigger
 * @param {string} name
 * @param {string} namespace
 * @param {object} options
 */
function handleMQTDeployment(trigger, name, namespace, options, kubeConfig) {
  let mqTrigger = trigger;
  // If only a string is passed, expect it to be the subject
  if (typeof mqTrigger === 'string') {
    // Defaults to Kafka
    mqTrigger = {
      queue: 'kafka',
      topic: mqTrigger,
    };
  } else {
    // Otherwise expect type and subject to be set
    if (_.isEmpty(mqTrigger.queue)) {
      throw new Error('You should specify a queue for the trigger event (i.e. kafka, nats)');
    }
    if (_.isEmpty(mqTrigger.topic)) {
      throw new Error('You should specify a topic for the trigger event');
    }
  }

  return deployMQTrigger(
    MQTypes[mqTrigger.queue.toLowerCase()],
    name,
    namespace,
    mqTrigger.topic,
    options, kubeConfig,
  );
}

function deployTrigger(event, funcName, namespace, service, options, kubeConfig) {
  let triggerPromise;
  let config;
  let defaultHostname;
  switch (event.type) {
    case 'http':
      if (_.isEmpty(event.path)) {
        throw new Error('You should specify a path for the trigger event');
      }
      config = loadKubeConfig(kubeConfig);
      // eslint-disable-next-line max-len
      defaultHostname = `${url.parse(getKubernetesAPIURL(config)).hostname}.${options.defaultDNSResolution || 'nip.io'}`;
      triggerPromise = deployHttpTrigger(
        funcName,
        namespace,
        event.path,
        {
          log: options.log,
          ingress: options.ingress || {},
          hostname: event.hostname || options.hostname || defaultHostname,
          labels: options.labels,
        }, kubeConfig,
      );
      break;
    case 'trigger':
      if (_.isEmpty(event.trigger)) {
        throw new Error('You should specify a topic or queue & topic for the trigger event');
      }
      triggerPromise = handleMQTDeployment(
        event.trigger,
        funcName,
        namespace,
        {
          log: options.log,
          labels: options.labels,
        }, kubeConfig,
      );
      break;
    case 'schedule':
      if (_.isEmpty(event.schedule)) {
        throw new Error('You should specify a schedule for the trigger event');
      }
      triggerPromise = deployScheduleTrigger(
        funcName,
        namespace,
        event.schedule,
        {
          log: options.log,
          labels: options.labels,
        }, kubeConfig,
      );
      break;
    default:
      throw new Error(`Event type ${event.type} is not supported`);
  }
  return triggerPromise;
}

export function deploy(functions, runtime, service, options, kubeConfig) {
  // Concurrents deploys to execute
  const deployConcurrency = process.env.DEPLOY_CONCURRENCY || Number.MAX_VALUE;

  return new BbPromise((deployResolve, deployReject) => {
    const deployQueue = functions.slice();

    const deployFunctions = (functionsToDeploy) => new BbPromise((resolve, reject) => {
      const errors = [];
      let counter = 0;
      // Total number of elements to deploy for this iteration
      const elements = getDeployableItemsNumber(functionsToDeploy);
      _.each(functionsToDeploy, (description) => {
        const opts = _.defaults({}, options, {
          hostname: null,
          namespace: 'default',
          memorySize: null,
          force: false,
          verbose: false,
          log: console.log,
          contentType: ('contentType' in description) ? description.contentType : 'text',
          labels: description.labels || {},
        });
        const ns = description.namespace || opts.namespace;
        if (description.handler) {
          deployFunction(description, ns, runtime, opts.contentType, opts, kubeConfig)
            .catch(deploymentErr => errors.push(deploymentErr))
            .then((res) => {
              if (res.code && res.code !== 200) {
                errors.push(res.message);
              }
              _.each(description.events, event => {
                deployTrigger(event, description.id, ns, service, opts, kubeConfig)
                  .catch(triggerErr => errors.push(triggerErr))
                  .then((tr) => {
                    if (tr && tr.code && tr.code !== 200) {
                      errors.push(tr.message);
                    }
                    counter++;
                    checkFinished(counter, elements, errors, resolve, reject);
                  });
              });
              counter++;
              checkFinished(counter, elements, errors, resolve, reject);
            });
        } else {
          counter++;
          opts.log(
            `Skipping deployment of ${description.id} since it doesn't have a handler`,
          );
          checkFinished(counter, elements, errors, resolve, reject);
        }
      });
    });

    const nextDeploy = () => {
      if (deployQueue.length > 0) {
        const functionsToDeploy = deployQueue.splice(0, deployConcurrency);
        deployFunctions(functionsToDeploy).then(() => nextDeploy()).catch((ex) => deployReject(ex));
      } else {
        deployResolve();
      }
    };

    nextDeploy();
  });
}
