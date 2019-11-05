const ObservableStore = require('obs-store')
const EventEmitter = require('safe-event-emitter')
const extend = require('xtend')
const sigUtil = require('eth-sig-util')
const normalizeAddress = sigUtil.normalize

/**
 * Accounts Controller
 *
 * Provides methods with the same interface as KeyringController
 * ( https://www.npmjs.com/package/eth-keyring-controller )
 * except will also fallback methods to the plugin accounts controller,
 * which allows Plugin account management.
 *
 */

class AccountsController extends EventEmitter {

  constructor (opts = {}) {
    super()

    const {
      keyringController, pluginAccountsController
    } = opts
    this.keyringController = keyringController
    this.pluginAccounts = pluginAccountsController

    const initState = extend({
      accountrings: [],
    }, opts.initState)
    this.store = new ObservableStore(initState)

    this.pluginAccounts.store.subscribe(() => {
      this.fullUpdate()
    })
  }

  async getAccounts () {
    const keyAccounts = await this.keyringController.getAccounts()
    const pluginAccounts = this.pluginAccounts.resources.map(acct => acct.address)
    return [...keyAccounts, ...pluginAccounts]
  }

  async exportAccount (address) {
    return this.keyringController.exportAccount(address)
  }

  async removeAccount (address) {
    const resources = this.pluginAccounts.resources
    const isResourceAccount = resources.find(resource => resource.address.toLowerCase() === address.toLowerCase())
    if (isResourceAccount) {
      resources.forEach(({ fromDomain, address: resourceAddres }) => {
        if (resourceAddres === address) {
          this.pluginAccounts.remove(fromDomain, address)
        }
      })
    }

    const currentState = this.store.getState()
    const accountrings = currentState.accountrings
    const isAccountRingsAccount = accountrings.find(accountring => accountring.accounts.includes(address))
    if (isAccountRingsAccount) {
      const newAccountRings = []
      accountrings.forEach(accountring => {
        const newAccountRingsAccounts = accountring.accounts.filter(account => account !== address)
        if (newAccountRingsAccounts.length) {
          newAccountRings.push({ ...accountring, accounts: newAccountRingsAccounts })
        }
      })
      this.store.updateState({
        ...currentState,
        accountrings: newAccountRings,
      })
    }

    try {
      const removeAccountResult = await this.keyringController.removeAccount(address)
      return removeAccountResult
    } catch (e) {
      if (e.message === 'No keyring found for the requested account.' && isAccountRingsAccount) {
        return address
      } else {
        throw e
      }
    }
  }

  async fullUpdate () {
    const update = await this.keyringController.fullUpdate()
    const pluginAccounts = this.pluginAccounts.resources

    const pluginTypes = pluginAccounts.map((account) => {
      return account.fromDomain
    })
      .filter(onlyUnique)
    update.keyringTypes = update.keyringTypes.concat(pluginTypes)

    const pluginKeyrings = pluginTypes.map((domain) => {
      const accounts = pluginAccounts.filter((account) => {
        return account.fromDomain === domain
      })
      .map(account => account.address)

      return {
        type: domain,
        accounts,
      }
    })

    update.accountrings = update.keyrings.concat(pluginKeyrings)
    this.store.updateState(update)
    return update
  }

  getHandlerForAccount (address) {
    const pluginAccounts = this.pluginAccounts.resources
    const accounts = pluginAccounts.filter(acct => normalizeAddress(acct.address) === address)
    const domains = accounts.map(acct => acct.fromDomain)
    const uniques = domains.filter(onlyUnique)

    if (uniques.length > 1) {
      throw new Error(`Multiple plugins claiming ownership of account ${address}, please request from plugin directly.`)
    }

    if (!this.pluginsController) {
      throw new Error('No handlers exist to manage account.')
    }

    const handler = this.pluginsController.accountMessageHandlers.get(uniques[0])
    if (uniques.length === 0 || !handler) {
      throw new Error(`No handler plugin for account ${address} found.`)
    }

    return handler
  }

  async signTransaction (ethTx, fromAddress, opts) {
    try {
      return this.keyringController.signTransaction(ethTx, fromAddress, opts)
    } catch (err) {
      const address = normalizeAddress(fromAddress)
      if (!this.pluginManagesAddress(address)) {
        throw new Error('No keyring or plugin found for the requested account.')
      }
      const handler = this.getHandlerForAccount(address)
      const tx = ethTx.toJSON(true)
      tx.from = fromAddress

      return handler({
        method: 'eth_signTransaction',
        params: [tx],
      })
    }
  }

  async signMessage (msgParams) {
    try {
      return this.keyringController.signMessage(msgParams)
    } catch (err) {
      const address = normalizeAddress(msgParams.from)
      if (!this.pluginManagesAddress(address)) {
        throw new Error('No keyring or plugin found for the requested account.')
      }
      const handler = this.getHandlerForAccount(address)
      return handler({
        method: 'eth_sign',
        params: [msgParams.from, msgParams.data],
      })
    }
  }

  async signPersonalMessage (msgParams) {
    try {
      return this.keyringController.signPersonalMessage(msgParams)
    } catch (err) {
      const address = normalizeAddress(msgParams.from)
      if (!this.pluginManagesAddress(address)) {
        throw new Error('No keyring or plugin found for the requested account.')
      }
      const handler = this.getHandlerForAccount(address)
      return handler({
        method: 'personal_sign',
        params: [msgParams.from, msgParams.data],
      })
    }
  }

  pluginManagesAddress (address) {
    const pluginAccounts = this.pluginAccounts.resources
    const normalized = pluginAccounts.map(acct => normalizeAddress(acct.address))
    return normalized.includes(address)
  }

  async exportAppKeyForAddress (account, origin) {
    try {
      return this.keyringController.exportAppKeyForAddress(account, origin)
    } catch (err) {
      const address = normalizeAddress(msgParams.from)
      if (!this.pluginManagesAddress(address)) {
        throw new Error('No keyring or plugin found for the requested account.')
      }
      throw new Error('Plugins cannot currently export app keys.')
    }
  }

  /**
   * TO IMPLEMENT:
   */

  async signTypedData () {
    throw new Error('This method is not yet supported on this plugin branch.')
  }

  async addNewAccount () {
    throw new Error('Plugin accounts must be added by that plugin.')
  }

}

// https://stackoverflow.com/a/14438954/272576
function onlyUnique (value, index, self) {
  return self.indexOf(value) === index
}

module.exports = AccountsController
