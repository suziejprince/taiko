const cri = require('chrome-remote-interface');
const childProcess = require('child_process');
const BrowserFetcher = require('./browserFetcher');
const removeFolder = require('rimraf');
const { helper, assert, waitFor, isString, isFunction } = require('./helper');
const removeFolderAsync = helper.promisify(removeFolder);
const inputHandler = require('./inputHandler');
const domHandler = require('./domHandler');
const networkHandler = require('./networkHandler');
const pageHandler = require('./pageHandler');
const targetHandler = require('./targetHandler');
const fs = require('fs');
const os = require('os');
const mkdtempAsync = helper.promisify(fs.mkdtemp);
const path = require('path');
const CHROME_PROFILE_PATH = path.join(os.tmpdir(), 'taiko_dev_profile-');
const ChromiumRevision = require(path.join(helper.projectRoot(), 'package.json')).taiko.chromium_revision;
const EventEmiter = require('events').EventEmitter;
const xhrEvent = new EventEmiter();
const default_timeout = 15000;
let chromeProcess, temporaryUserDataDir, page, network, runtime, input, client, dom, emulation, overlay, criTarget, currentPort, currentHost, rootId = null,
    headful, security, ignoreSSLErrors, observe, observeTime;


const connect_to_cri = async (target) => {
    if(client){
        client.removeAllListeners();
    }
    return new Promise(async function connect(resolve) {
        try {
            if (!target) target = await cri.New({ host: currentHost, port: currentPort });
            await cri({ target }, async (c) => {
                client = c;
                page = c.Page;
                network = c.Network;
                runtime = c.Runtime;
                input = c.Input;
                dom = c.DOM;
                emulation = c.Emulation;
                criTarget = c.Target;
                overlay = c.Overlay;
                security = c.Security;
                await Promise.all([network.enable(), page.enable(), dom.enable(), overlay.enable(), security.enable()]);
                await networkHandler.setNetwork(network, xhrEvent);
                await inputHandler.setInput(input);
                await domHandler.setDOM(dom);
                await targetHandler.setTarget(criTarget, xhrEvent, connect_to_cri, currentHost, currentPort);
                await pageHandler.setPage(page, xhrEvent, async function () {
                    if (!client) return;
                    rootId = null;
                    const { root: { nodeId } } = await dom.getDocument();
                    rootId = nodeId;
                });
                if (ignoreSSLErrors) security.setIgnoreCertificateErrors({ ignore: true });
                resolve();
            });
        } catch (e) { setTimeout(() => { connect(resolve); }, 1000).unref(); }
    });
};

const setBrowserOptions = (options) => {
    options.port = options.port || 0;
    options.host = options.host || '127.0.0.1';
    options.headless = options.headless === undefined || options.headless === null ? true : options.headless;
    headful = !options.headless;
    ignoreSSLErrors = options.ignoreCertificateErrors;
    observe = options.observe || false;
    observeTime = options.observeTime || 3000;
    return options;
};

/**
 * Launches a browser with a tab. The browser will be closed when the parent node.js process is closed.
 *
 * @example
 * openBrowser()
 * openBrowser({ headless: false })
 * openBrowser({args:['--window-size=1440,900']})
 * openBrowser({args: [
 *      '--disable-gpu',
 *       '--disable-dev-shm-usage',
 *       '--disable-setuid-sandbox',
 *       '--no-first-run',
 *       '--no-sandbox',
 *       '--no-zygote']}) - These are recommended args that has to be passed when running in docker
 *
 * @param {Object} options {headless: true|false, args:['--window-size=1440,900']}
 * @param {boolean} [options.headless=true] - Option to let open browser in headless/headful mode.
 * @param {Array} [options.args] - Args to open chromium https://peter.sh/experiments/chromium-command-line-switches/.
 * @param {number} [options.port=0] - Remote debugging port if not given connects to any open port.
 * @param {boolean} [options.ignoreCertificateErrors=false] - Option to ignore certificate errors.
 * @param {boolean} [options.observe=false] - Option to run commands with delay to observe what's happening.
 * @param {number} [option.observeTime=3000] - Option to modify delay time for observe mode.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.openBrowser = async (options = { headless: true }) => {
    const browserFetcher = new BrowserFetcher();
    const revisionInfo = browserFetcher.revisionInfo(ChromiumRevision);
    options = setBrowserOptions(options);
    let args = [`--remote-debugging-port=${options.port}`,'--use-mock-keychain'];
    if (!args.some(arg => arg.startsWith('--user-data-dir'))) {
        temporaryUserDataDir = await mkdtempAsync(CHROME_PROFILE_PATH);
        args.push(`--user-data-dir=${temporaryUserDataDir}`);
    }
    if (options.headless) args = args.concat(['--headless', '--window-size=1440,900']);
    if (options.args) args = args.concat(options.args);
    assert(revisionInfo.local, 'Chromium revision is not downloaded. Run "npm install"');
    const chromeExecutable = revisionInfo.executablePath;
    chromeProcess = childProcess.spawn(chromeExecutable, args);
    const endpoint = await browserFetcher.waitForWSEndpoint(chromeProcess, default_timeout);
    currentHost = endpoint.host;
    currentPort = endpoint.port;
    await connect_to_cri();
    return { description: 'Browser opened' };
};

/**
 * Closes the browser and all of its tabs (if any were opened).
 *
 * @example
 * closeBrowser()
 *
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.closeBrowser = async () => {
    validate();
    await _closeBrowser();
    networkHandler.resetInterceptors();
    return { description: 'Browser closed' };
};

const _closeBrowser = async () => {
    if (client) {
        await page.close();
        await client.close();
        client = null;
    }
    chromeProcess.kill('SIGTERM');
    chromeProcess.once('exit', async () => {
        if (temporaryUserDataDir) {
            try {
                await removeFolderAsync(temporaryUserDataDir);
            } catch (e) { }
        }
    });
};

/**
 * Gives CRI client object.
 *
 * @returns {Object}
 */
module.exports.client = () => client;

/**
 * Allows to switch between tabs using URL or page title.
 *
 * @example
 * switchTo('https://taiko.gauge.org/') - switch using URL
 * switchTo('Taiko') - switch using Title
 *
 * @param {string} targetUrl - URL/Page title of the tab to switch.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.switchTo = async (targetUrl) => {
    const target = await targetHandler.getCriTarget(targetUrl);
    await connect_to_cri(target);
    const { root: { nodeId } } = await dom.getDocument();
    rootId = nodeId;
    return { description: `Switched to tab with url "${targetUrl}"` };
};

/**
 * Sets page viewport.
 *
 * @example
 * setViewPort({width:600,height:800})
 *
 * @param {Object} options - https://chromedevtools.github.io/devtools-protocol/tot/Emulation#method-setDeviceMetricsOverride
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.setViewPort = async (options) => {
    if (options.height === undefined || options.width === undefined) throw new Error('No height and width provided');
    options.mobile = options.mobile || false;
    options.deviceScaleFactor = options.deviceScaleFactor || 1;
    await emulation.setDeviceMetricsOverride(options);
    return { description: `ViewPort is set to width ${options.width} and height ${options.height}` };
};

/**
 * Launches a new tab with given url.
 *
 * @example
 * openTab('https://taiko.gauge.org/')
 *
 * @param {string} targetUrl - URL/Page title of the tab to switch.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.openTab = async (targetUrl, options = { timeout: 30000 }) => {
    if (!/^https?:\/\//i.test(targetUrl) && !/^file/i.test(targetUrl)) targetUrl = 'http://' + targetUrl;
    const targetPromise = new Promise((resolve) => {
        xhrEvent.addListener('targetNavigated', resolve);
    });
    const promises = [targetPromise];
    await criTarget.createTarget({ url: targetUrl });
    await waitForNavigation(options.timeout, promises).catch(handleTimeout(options.timeout));
    xhrEvent.removeAllListeners();
    return { description: `Opened tab with url "${targetUrl}"` };
};

/**
 * Closes the given tab with given url or closes current tab.
 *
 * @example
 * closeTab() - Closes the current tab.
 * closeTab('https://gauge.org') - Closes the tab with url 'https://gauge.org'.
 *
 * @param {string} targetUrl - URL/Page title of the tab to switch.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.closeTab = async (targetUrl) => {
    if (!targetUrl) {
        targetUrl = await _getDocumentUrl();
    }
    let target = await targetHandler.getCriTarget(targetUrl);
    let targetToConnect = await targetHandler.getTargetToConnect(targetUrl);
    if (!targetToConnect) {
        await _closeBrowser();
        return { description: 'Closing last target and browser.' };
    }
    await cri.Close({ host: currentHost, port: currentPort, id: target.id });
    await connect_to_cri(targetHandler.constructCriTarget(targetToConnect));
    const { root: { nodeId } } = await dom.getDocument();
    rootId = nodeId;
    return { description: `Closed tab with url "${targetUrl}"` };
};

/**
 * Opens the specified URL in the browser's tab. Adds `http` protocol to the URL if not present.
 *
 * @example
 * goto('https://google.com')
 * goto('google.com')
 *
 * @param {string} url - URL to navigate page to.
 * @param {Object} options - {timeout:5000, headers:{'Authorization':'Basic cG9zdG1hbjpwYXNzd29y2A=='}} Default timeout is 30 seconds to override set options = {timeout:10000}, headers to override defaults.
 * @returns {Promise<Object>} - Object with the description of the action performed and the final URL.
 */
module.exports.goto = async (url, options = { timeout: 30000 }) => {
    validate();
    if (!/^https?:\/\//i.test(url) && !/^file/i.test(url)) url = 'http://' + url;
    const promises = [page.loadEventFired(), 
        page.frameStoppedLoading(), 
        page.domContentEventFired(),
        new Promise((resolve) => {
            xhrEvent.addListener('networkIdle', resolve);
        })
    ];
    if (options.headers) await network.setExtraHTTPHeaders({ headers: options.headers });
    const res = await page.navigate({ url: url });
    if (res.errorText) throw new Error(`Navigation to url ${url} failed.\n REASON: ${res.errorText}`);
    await waitForNavigation(options.timeout, promises).catch(handleTimeout(options.timeout));
    xhrEvent.removeAllListeners();
    return { description: `Navigated to url "${url}"`, url: url };
};

/**
 * Reloads the page.
 *
 * @example
 * reload('https://google.com')
 * reload('https://google.com', { timeout: 10000 })
 *
 * @param {string} url - URL to reload
 * @returns {Promise<Object>} - Object with the description of the action performed and the final URL.
 */
module.exports.reload = async (url) => {
    validate();
    await page.reload(url);
    return { description: `"${url}" reloaded`, url: url };
};

/**
 * Returns page's title.
 *
 * @returns {Promise<String>}
 */
module.exports.title = async () => {
    validate();
    const result = await runtime.evaluate({
        expression: 'document.querySelector("title").textContent'
    });

    return result.result.value;
};

const setNavigationOptions = (options) => {
    options.awaitNavigation = options.waitForNavigation === undefined || options.waitForNavigation === null ?
        true : options.waitForNavigation;
    options.timeout = options.timeout || default_timeout;
    options.waitForStart = options.waitForStart || 500;
    return options;
};

const setOptions = (options, x, y) => {
    options = setNavigationOptions(options);
    options.x = x;
    options.y = y;
    options.button = options.button || 'left';
    options.clickCount = options.clickCount || 1;
    options.elementsToMatch = options.elementsToMatch || 10;
    return options;
};

const checkIfElementAtPointOrChild = async (e, x, y) => {

    function isElementAtPointOrChild(value) {
        const node = document.elementFromPoint(value.x, value.y);
        return this.contains(node) ||
            (window.getComputedStyle(node).getPropertyValue('opacity') < 0.1) ||
            (window.getComputedStyle(this).getPropertyValue('opacity') < 0.1);
    }

    const { object: { objectId } } = await dom.resolveNode({ nodeId: e });
    const res = await runtime.callFunctionOn({
        functionDeclaration: isElementAtPointOrChild.toString(),
        'arguments': [{ value: { x: x, y: y } }],
        objectId
    });
    return res.result.value;
};

const getChildNodes = async (element) => {
    function getChild() {
        return this.childNodes;
    }
    const childNodes = [];
    const res = await evaluate(element, getChild);
    const { result } = await runtime.getProperties(res);
    for (const r of result) {
        if (isNaN(r.name)) break;
        childNodes.push((await dom.requestNode({ objectId: r.value.objectId })).nodeId);
    }
    return childNodes;
};

const checkIfChildOfOtherMatches = async (elements, x, y) => {
    const result = await runtime.evaluate({ expression: `document.elementFromPoint(${x},${y})` });
    const { nodeId } = await dom.requestNode({ objectId: result.result.objectId });
    if (elements.includes(nodeId)) return true;
    for (const element of elements) {
        const childNodes = await getChildNodes(element);
        if (childNodes.includes(nodeId)) return true;
    }
    const childOfNodeAtPoint = await getChildNodes(nodeId);
    if (childOfNodeAtPoint.some((val) => elements.includes(val))) return true;
    return false;
};

const checkIfElementIsCovered = async (elem, x, y, elems, isElemAtPoint) => {
    isElemAtPoint = await checkIfElementAtPointOrChild(elem, parseInt(x), parseInt(y));
    //If element to be clicked and element at point are different check if it is any other element matching the selector
    if (!isElemAtPoint)
        isElemAtPoint = await checkIfChildOfOtherMatches(elems, parseInt(x), parseInt(y));
    return isElemAtPoint;
};

/**
 * Fetches an element with the given selector, scrolls it into view if needed, and then clicks in the center of the element. If there's no element matching selector, the method throws an error.
 *
 * @example
 * click('Get Started')
 * click(link('Get Started'))
 *
 * @param {selector|string} selector - A selector to search for element to click. If there are multiple elements satisfying the selector, the first will be clicked.
 * @param {Object} options - Click options.
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the click. Default navigation timeout is 15 seconds, to override pass `{ timeout: 10000 }` in `options` parameter.
 * @param {number} [options.waitForStart=500] - wait for navigation to start. Default to 500ms
 * @param {number} [options.timeout=5000] - Timeout value in milliseconds for navigation after click.
 * @param {string} [options.button='left'] - `left`, `right`, or `middle`.
 * @param {number} [options.clickCount=1] - Number of times to click on the element.
 * @param {number} [options.elementsToMatch=10] - Number of elements to loop through to match the element with given selector.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.click = click;

async function click(selector, options = {}, ...args) {
    validate();
    if (options instanceof RelativeSearchElement) {
        args = [options].concat(args);
        options = {};
    }
    const elems = isNaN(selector) ? (await handleRelativeSearch(await elements(selector), args)) : [selector];
    let elemsLength = elems.length;
    let isElemAtPoint;
    options = setOptions(options);
    if (elemsLength > options.elementsToMatch) {
        elems.splice(options.elementsToMatch, elems.length);
    }
    for (let elem of elems) {
        isElemAtPoint = false;
        await scrollTo(elem);
        const { x, y } = await domHandler.boundingBoxCenter(elem);
        isElemAtPoint = await checkIfElementIsCovered(elem, x, y, elems, isElemAtPoint);
        options = setOptions(options, x, y);
        if (isElemAtPoint) {
            const type = (await evaluate(elem, function getType() { return this.type; })).value;
            assertType(elem, () => type !== 'file', 'Unsupported operation, use `attach` on file input field');
            if (headful) await highlightElemOnAction(elem);
            break;
        }
    }
    if (!isElemAtPoint && elemsLength != elems.length)
        throw Error('Please provide a better selector, Too many matches.');
    if (!isElemAtPoint)
        throw Error(description(selector) + ' is coverred by other element');
    await doActionAwaitingNavigation(options, async () => {
        options.type = 'mouseMoved';
        await input.dispatchMouseEvent(options);
        options.type = 'mousePressed';
        await input.dispatchMouseEvent(options);
        options.type = 'mouseReleased';
        await input.dispatchMouseEvent(options);
    });
    return { description: 'Clicked ' + description(selector, true) };
}

/**
 * Fetches an element with the given selector, scrolls it into view if needed, and then double clicks the element. If there's no element matching selector, the method throws an error.
 *
 * @example
 * doubleClick('Get Started')
 * doubleClick(button('Get Started'))
 *
 * @param {selector|string} selector - A selector to search for element to click. If there are multiple elements satisfying the selector, the first will be double clicked.
 * @param {Object} options - Click options.
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the click. Default navigation timout is 15 seconds, to override pass `{ timeout: 10000 }` in `options` parameter.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.doubleClick = async (selector, options = {}, ...args) => {
    if (options instanceof RelativeSearchElement) {
        args = [options].concat(args);
        options = {};
    }
    options = {
        waitForNavigation: options.waitForNavigation !== undefined ? options.waitForNavigation : false,
        clickCount: 2
    };
    await click(selector, options, ...args);
    return { description: 'Double clicked ' + description(selector, true) };
};

/**
 * Fetches an element with the given selector, scrolls it into view if needed, and then right clicks the element. If there's no element matching selector, the method throws an error.
 *
 * @example
 * rightClick('Get Started')
 * rightClick(text('Get Started'))
 *
 * @param {selector|string} selector - A selector to search for element to right click. If there are multiple elements satisfying the selector, the first will be double clicked.
 * @param {Object} options - Click options.
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the click. Default navigation timout is 15 seconds, to override pass `{ timeout: 10000 }` in `options` parameter.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.rightClick = async (selector, options = {}, ...args) => {
    if (options instanceof RelativeSearchElement) {
        args = [options].concat(args);
        options = {};
    }
    options = {
        waitForNavigation: options.waitForNavigation !== undefined ? options.waitForNavigation : false,
        button: 'right'
    };
    await click(selector, options, ...args);
    return { description: 'Right clicked ' + description(selector, true) };
};

/**
 * Fetches an element with the given selector, scrolls it into view if needed, and then hovers over the center of the element. If there's no element matching selector, the method throws an error.
 *
 * @example
 * hover('Get Started')
 * hover(link('Get Started'))
 *
 * @param {selector|string} selector - A selector to search for element to right click. If there are multiple elements satisfying the selector, the first will be hovered.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.hover = async (selector, options = {}) => {
    validate();
    options = setNavigationOptions(options);
    const e = await element(selector);
    await scrollTo(e);
    if (headful) await highlightElemOnAction(e);
    const { x, y } = await domHandler.boundingBoxCenter(e);
    const option = {
        x: x,
        y: y
    };
    await doActionAwaitingNavigation(options, async () => {
        Promise.resolve().then(() => {
            option.type = 'mouseMoved';
            return input.dispatchMouseEvent(option);
        }).catch((err) => {
            throw new Error(err);
        });
    });
    return { description: 'Hovered over the ' + description(selector, true) };
};

/**
 * Fetches an element with the given selector and focuses it. If there's no element matching selector, the method throws an error.
 *
 * @example
 * focus(textField('Username:'))
 *
 * @param {selector|string} selector - A selector of an element to focus. If there are multiple elements satisfying the selector, the first will be focused.
 * @param {object} options - {waitForNavigation:true,waitForStart:500,timeout:10000}
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.focus = async (selector, options = {}) => {
    validate();
    options = setNavigationOptions(options);
    await doActionAwaitingNavigation(options, async () => {
        if (headful) await highlightElemOnAction(await element(selector));
        await _focus(selector);
    });
    return { description: 'Focussed on the ' + description(selector, true) };
};

/**
 * Types the given text into the focused or given element.
 *
 * @example
 * write('admin', into('Username:'))
 * write('admin', 'Username:')
 * write('admin')
 *
 * @param {string} text - Text to type into the element.
 * @param {selector|string} [into] - A selector of an element to write into.
 * @param {Object} [options]
 * @param {number} options.delay - Time to wait between key presses in milliseconds.
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the click. Default navigation timeout is 15 seconds, to override pass `{ timeout: 10000 }` in `options` parameter.
 * @param {number} [options.waitForStart=500] - wait for navigation to start. Default to 500ms
 * @param {number} [options.timeout=5000] - Timeout value in milliseconds for navigation after click
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.write = async (text, into, options = { delay: 10 }) => {
    validate();
    let desc;
    if (into && into.delay) {
        options.delay = into.delay;
        into = undefined;
    }
    options = setNavigationOptions(options);
    await doActionAwaitingNavigation(options, async () => {
        if (into) {
            const selector = isString(into) ? textField(into) : into;
            await _focus(selector);
            await _write(text, options);
            text = (await isPasswordField()) ? '*****' : text;
            desc = `Wrote ${text} into the ` + description(selector, true);
            return;
        } else {
            await _waitForFocus(options.timeout || default_timeout);
            await _write(text, options);
            text = (await isPasswordField()) ? '*****' : text;
            desc = `Wrote ${text} into the focused element.`;
            return;
        }
    });
    return { description: desc };
};

const _waitForFocus = (timeout) => {
    return Promise.race([
        new Promise(resolve => { setTimeout(() => resolve(), timeout).unref(); }),
        new Promise(resolve => {
            setTimeout(() => {
                runtime.evaluate({ expression: 'document.hasFocus()' }).then((result) => {
                    if (result) resolve();
                });
            }, 500).unref();
        })
    ]);
};

const isPasswordField = async () => {
    const result = await runtime.evaluate({
        expression: 'document.activeElement.type'
    });
    return (result.result.value === 'password');
};

const _getActiveElementTagName = async () => {
    const result = await runtime.evaluate({
        expression: 'document.activeElement.tagName'
    });
    return result.result.value;
};

const _getActiveElementIsContentEditable = async () => {
    const result = await runtime.evaluate({
        expression: 'document.activeElement.isContentEditable'
    });
    return result.result.value;
};

const _getActiveElementDisabled = async () => {
    const result = await runtime.evaluate({
        expression: 'document.activeElement.disabled'
    });
    return result.result.value;
};

const _isActiveFieldNotWritable = async () => {
    const editable = (['INPUT', 'TEXTAREA', 'SELECT'].includes(await _getActiveElementTagName()) || (await _getActiveElementIsContentEditable()));
    const disabled = await _getActiveElementDisabled();
    return !editable || disabled;
};

const _write = async (text, options) => {
    if (await _isActiveFieldNotWritable())
        throw new Error('Element focused is not writable');
    if (headful) {
        const result = await runtime.evaluate({ expression: 'document.activeElement' });
        const { nodeId } = await dom.requestNode({ objectId: result.result.objectId });
        await highlightElemOnAction(nodeId);
    }
    for (const char of text) {
        await new Promise(resolve => setTimeout(resolve, options.delay).unref());
        await input.dispatchKeyEvent({ type: 'char', text: char });
    }
};

const _getDocumentUrl = async () => {
    const result = await runtime.evaluate({
        expression: 'window.location.toString()'
    });
    return result.result.value;
};

/**
 * Clears the value of given selector. If no selector is given clears the current active element.
 *
 * @example
 * clear()
 * clear(inputField({placeholder:'Email'}))
 *
 * @param {selector} selector - A selector to search for element to clear. If there are multiple elements satisfying the selector, the first will be cleared.
 * @param {Object} options - Click options.
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after clear. Default navigation timeout is 15 seconds, to override pass `{ timeout: 10000 }` in `options` parameter.
 * @param {number} [options.waitForStart=500] - wait for navigation to start. Default to 500ms
 * @param {number} [options.timeout=5000] - Timeout value in milliseconds for navigation after click.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.clear = async (selector, options = {}) => {
    let nodeId, desc;
    options = setNavigationOptions(options);
    if(selector)await _focus(selector);
    if (await _isActiveFieldNotWritable())
        throw new Error('Element cannot be cleared');
    if (!selector) {
        const result = await runtime.evaluate({ expression: 'document.activeElement' });
        const res = await dom.requestNode({ objectId: result.result.objectId });
        nodeId = res.nodeId;
        desc = { description: 'Cleared element on focus' };
    } else {
        nodeId = await element(selector);
        desc = { description: 'Cleared ' + description(selector, true) };
    }
    await doActionAwaitingNavigation(options, async () => {
        await _clear(nodeId);
        if (headful) await highlightElemOnAction(nodeId);
    });
    return desc;
};

const _clear = async (elem) => {
    await click(elem, { clickCount: 3, waitForNavigation: false });
    await inputHandler.down('Backspace');
    await inputHandler.up('Backspace');
};

/**
 * Attaches a file to a file input element.
 *
 * @example
 * attach('c:/abc.txt', to('Please select a file:'))
 * attach('c:/abc.txt', 'Please select a file:')
 *
 * @param {string} filepath - The path of the file to be attached.
 * @param {selector|string} to - The file input element to which to attach the file.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.attach = async (filepath, to) => {
    validate();
    let resolvedPath = filepath ? path.resolve(process.cwd(), filepath) : path.resolve(process.cwd());
    fs.open(resolvedPath, 'r', (err) => {
        if (err && err.code === 'ENOENT') {
            throw new Error(`File ${resolvedPath} doesnot exists.`);
        }
    });
    if (isString(to)) to = fileField(to);
    else if (!isSelector(to)) throw Error('Invalid element passed as paramenter');
    const nodeId = await element(to);
    if (headful) await highlightElemOnAction(nodeId);
    await dom.setFileInputFiles({
        nodeId: nodeId,
        files: [resolvedPath]
    });
    return { description: `Attached ${resolvedPath} to the ` + description(to, true) };
};

/**
 * Presses the given keys.
 *
 * @example
 * press('Enter')
 * press('a')
 * press(['Shift', 'ArrowLeft', 'ArrowLeft'])
 *
 * @param {string | Array<string> } keys - Name of keys to press, such as ArrowLeft. See [USKeyboardLayout](https://github.com/getgauge/taiko/blob/master/lib/USKeyboardLayout.js) for a list of all key names.
 * @param {Object} options
 * @param {string} [options.text] - If specified, generates an input event with this text.
 * @param {number} [options.delay=0] - Time to wait between keydown and keyup in milliseconds.
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the click. Default navigation timeout is 15 seconds, to override pass `{ timeout: 10000 }` in `options` parameter.
 * @param {number} [options.waitForStart=500] - wait for navigation to start. Default to 500ms
 * @param {number} [options.timeout=5000] - Timeout value in milliseconds for navigation after click.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.press = async (keys, options = {}) => {
    validate();
    options = setNavigationOptions(options);
    return await _press(new Array().concat(keys), options);
};

async function _press(keys, options) {
    await doActionAwaitingNavigation(options, async () => {
        for (let i = 0; i < keys.length; i++) await inputHandler.down(keys[i], options);
        if (options && options.delay) await new Promise(f => setTimeout(f, options.delay).unref());
        keys = keys.reverse();
        for (let i = 0; i < keys.length; i++) await inputHandler.up(keys[i]);
    });
    return { description: `Pressed the ${keys.reverse().join(' + ')} key` };
}


/**
 * Highlights the given element on the page by drawing a red rectangle around it. This is useful for debugging purposes.
 *
 * @example
 * highlight('Get Started')
 * highlight(link('Get Started'))
 *
 * @param {selector|string} selector - A selector of an element to highlight. If there are multiple elements satisfying the selector, the first will be highlighted.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.highlight = highlight;

async function highlight(selector) {
    validate();

    function highlightNode() {
        this.style.border = '0.5em solid red';
        return true;
    }
    await evaluate(selector, highlightNode);
    return { description: 'Highlighted the ' + description(selector, true) };
}

/**
 * Scrolls the page to the given element.
 *
 * @example
 * scrollTo('Get Started')
 * scrollTo(link('Get Started'))
 *
 * @param {selector|string} selector - A selector of an element to scroll to.
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.scrollTo = async (selector, options = {}) => {
    options = setNavigationOptions(options);
    await doActionAwaitingNavigation(options, async () => {
        await scrollTo(selector);
    });
    if (headful) await highlightElemOnAction(await element(selector));
    return { description: 'Scrolled to the ' + description(selector, true) };
};

async function scrollTo(selector) {
    validate();

    function scrollToNode() {
        this.scrollIntoViewIfNeeded();
        return 'result';
    }
    await evaluate(selector, scrollToNode);
}

const scroll = async (e, px, scrollPage, scrollElement, direction) => {
    e = e || 100;
    if (Number.isInteger(e)) {
        await runtime.evaluate({ expression: `(${scrollPage}).apply(null, ${JSON.stringify([e])})` });
        return { description: `Scrolled ${direction} the page by ${e} pixels` };
    }

    const nodeId = await element(e);
    if (headful) await highlightElemOnAction(nodeId);
    const { object: { objectId } } = await dom.resolveNode({ nodeId });
    //TODO: Allow user to set options for scroll
    const options = setNavigationOptions({});
    await doActionAwaitingNavigation(options, async () => {
        await runtime.callFunctionOn({
            functionDeclaration: scrollElement.toString(),
            'arguments': [{ value: px }],
            objectId
        });
    });
    return { description: `Scrolled ${direction} ` + description(e, true) + ` by ${px} pixels` };
};

/**
 * Scrolls the page/element to the right.
 *
 * @example
 * scrollRight()
 * scrollRight(1000)
 * scrollRight('Element containing text')
 * scrollRight('Element containing text', 1000)
 *
 * @param {selector|string|number} [e='Window']
 * @param {number} [px=100]
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.scrollRight = async (e, px = 100) => {
    validate();
    return await scroll(e, px, px => window.scrollBy(px, 0), function sr(px) { this.scrollLeft += px; return true; }, 'right');
};

/**
 * Scrolls the page/element to the left.
 *
 * @example
 * scrollLeft()
 * scrollLeft(1000)
 * scrollLeft('Element containing text')
 * scrollLeft('Element containing text', 1000)
 *
 * @param {selector|string|number} [e='Window']
 * @param {number} [px=100]
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.scrollLeft = async (e, px = 100) => {
    validate();
    return await scroll(e, px, px => window.scrollBy(px * -1, 0), function sl(px) { this.scrollLeft -= px; return true; }, 'left');
};

/**
 * Scrolls up the page/element.
 *
 * @example
 * scrollUp()
 * scrollUp(1000)
 * scrollUp('Element containing text')
 * scrollUp('Element containing text', 1000)
 *
 * @param {selector|string|number} [e='Window']
 * @param {number} [px=100]
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.scrollUp = async (e, px = 100) => {
    validate();
    return await scroll(e, px, px => window.scrollBy(0, px * -1), function su(px) { this.scrollTop -= px; return true; }, 'up');
};

/**
 * Scrolls down the page/element.
 *
 * @example
 * scrollDown()
 * scrollDown(1000)
 * scrollDown('Element containing text')
 * scrollDown('Element containing text', 1000)
 *
 * @param {selector|string|number} [e='Window']
 * @param {number} [px=100]
 * @returns {Promise<Object>} - Object with the description of the action performed.
 */
module.exports.scrollDown = async (e, px = 100) => {
    validate();
    return await scroll(e, px, px => window.scrollBy(0, px), function sd(px) { this.scrollTop += px; return true; }, 'down');
};

/**
 * Captures a screenshot of the page. Appends timeStamp to filename if no filepath given.
 *
 * @example
 * screenshot()
 * screenshot({path : 'screenshot.png'})
 *
 * @param {object} options - {path:'screenshot.png'} or {encoding:'base64'}
 * @returns {Promise<Buffer>} - Promise which resolves to buffer with captured screenshot if {encoding:'base64} given.
 * @returns {Promise<object>} - Object with the description of the action performed
 */
module.exports.screenshot = async (options = {}) => {
    validate();
    options.path = options.path || `Screenshot-${Date.now()}.png`;
    const { data } = await page.captureScreenshot();
    if (options.encoding === 'base64') return data;
    fs.writeFileSync(options.path, Buffer.from(data, 'base64'));
    return { description: `Screenshot is created at "${options.path}"` };
};

/**
 * This {@link selector} lets you identify elements on the web page via XPath or CSS selector.
 * @example
 * highlight($(`//*[text()='text']`))
 * $(`//*[text()='text']`).exists()
 * $(`#id`)
 *
 * @param {string} selector - XPath or CSS selector.
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.$ = (selector, ...args) => {
    validate();
    const get = async () => await handleRelativeSearch(await (selector.startsWith('//') || selector.startsWith('(') ? $$xpath(selector) : $$(selector)), args);
    return {
        get: getIfExists(get),
        exists: exists(getIfExists(get)),
        description: `Custom selector $(${selector})`,
        text: selectorText(get)
    };
};

const getValues = (attrValuePairs, args) => {

    if (attrValuePairs instanceof RelativeSearchElement) {
        args = [attrValuePairs].concat(args);
        return { args: args };
    }

    if (isString(attrValuePairs) || isSelector(attrValuePairs)) {
        return { label: attrValuePairs, args: args };
    }

    return { attrValuePairs: attrValuePairs, args: args };
};

const getQuery = (attrValuePairs, tag = '') => {
    let xpath = tag;
    for (const key in attrValuePairs) {
        if (key === 'class') xpath += `[${key}*="${attrValuePairs[key]}"]`;
        else xpath += `[${key}="${attrValuePairs[key]}"]`;
    }
    return xpath;
};


const getElementGetter = (selector, query, tag) => {
    let get;
    if (selector.attrValuePairs) get = async () => await handleRelativeSearch(await $$(getQuery(selector.attrValuePairs, tag)), selector.args);
    else if (selector.label) get = async () => await handleRelativeSearch(await query(), selector.args);
    else get = async () => await handleRelativeSearch(await $$(tag), selector.args);
    return get;
};

const desc = (selector, query, tag) => {
    let description = '';
    if (selector.attrValuePairs) description = getQuery(selector.attrValuePairs, tag);
    else if (selector.label) description = `${tag} with ${query} ${selector.label} `;

    for (const arg of selector.args) {
        description += description === '' ? tag : ' and';
        description += ' ' + arg.toString();
    }

    return description;
};

/**
 * This {@link selector} lets you identify an image on a web page. Typically, this is done via the image's alt text or attribute and value pairs.
 *
 * @example
 * click(image('alt'))
 * image('alt').exists()
 *
 * @param {string} alt - The image's alt text.
 * @param {object} attrValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.image = (attrValuePairs, ...args) => {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector, async () => await $$xpath(`//img[contains(@alt, ${xpath(selector.label)})]`), 'img');
    return { get: getIfExists(get), exists: exists(getIfExists(get)), description: desc(selector, 'alt', 'Image'), text: selectorText(get) };
};

/**
 * This {@link selector} lets you identify a link on a web page with text or attribute and value pairs.
 *
 * @example
 * click(link('Get Started'))
 * link('Get Started').exists()
 *
 * @param {string} text - The link text.
 * @param {object} attrValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.link = (attrValuePairs, ...args) => {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector, async () => await elements(selector.label, 'a'), 'a');
    return { get: getIfExists(get), exists: exists(getIfExists(get)), description: desc(selector, 'text', 'Link'), text: selectorText(get) };
};

/**
 * This {@link selector} lets you identify a list item (HTML <li> element) on a web page with label or attribute and value pairs.
 *
 * @example
 * highlight(listItem('Get Started'))
 * listItem('Get Started').exists()
 *
 * @param {string} label - The label of the list item.
 * @param {object} attrValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.listItem = (attrValuePairs, ...args) => {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector, async () => await elements(selector.label, 'li'), 'li');
    return { get: getIfExists(get), exists: exists(getIfExists(get)), description: desc(selector, 'label', 'List item'), text: selectorText(get) };
};

/**
 * This {@link selector} lets you identify a button on a web page with label or attribute and value pairs.
 *
 * @example
 * highlight(button('Get Started'))
 * button('Get Started').exists()
 *
 * @param {string} label - The button label.
 * @param {object} attrValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.button = (attrValuePairs, ...args) => {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector, async () => await elements(selector.label, 'button'), 'button');
    return { get: getIfExists(get), exists: exists(getIfExists(get)), description: desc(selector, 'label', 'Button'), text: selectorText(get) };
};

/**
 * This {@link selector} lets you identify an input field on a web page with label or attribute and value pairs.
 *
 * @example
 * focus(inputField({'id':'name'})
 * inputField({'id': 'name'}).exists()
 *
 * @param {object} attrValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.inputField = (attrValuePairs, ...args) => {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector, async () =>
        await $$xpath(`//input[@id=(//label[contains(text(), ${xpath(selector.label)})]/@for)]`), 'input');
    return {
        get: getIfExists(get),
        exists: exists(getIfExists(get)),
        description: desc(selector, 'label', 'Input Field'),
        value: async () => (await evaluate((await get())[0], function getvalue() { return this.value; })).value,
        text: selectorText(get)
    };
};

/**
 * This {@link selector} lets you identify a file input field on a web page either with label or with attribute and value pairs.
 *
 * @example
 * fileField('Please select a file:').value()
 * fileField('Please select a file:').exists()
 * fileField({'id':'file'}).exists()
 *
 * @param {string} label - The label (human-visible name) of the file input field.
 * @param {object} attrValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.fileField = fileField;

function fileField(attrValuePairs, ...args) {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector,
        async () => await $$xpath(`//input[@type='file'][@id=(//label[contains(text(), ${xpath(selector.label)})]/@for)]`),
        'input[type="file"]');
    return {
        get: getIfExists(get),
        exists: exists(getIfExists(get)),
        value: async () => (await evaluate((await get())[0], function getvalue() { return this.value; })).value,
        description: desc(selector, 'label', 'File field'),
        text: selectorText(get)
    };
}

/**
 * This {@link selector} lets you identify a text field on a web page either with label or with attribute and value pairs.
 *
 * @example
 * focus(textField('Username:'))
 * textField('Username:').exists()
 *
 * @param {object} attrValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {string} label - The label (human-visible name) of the text field.
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.textField = textField;

function textField(attrValuePairs, ...args) {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector,
        async () => await $$xpath(`//input[@type='text'][@id=(//label[contains(text(), ${xpath(selector.label)})]/@for)]`),
        'input[type="text"]');
    return {
        get: getIfExists(get),
        exists: exists(getIfExists(get)),
        description: desc(selector, 'label', 'Text field'),
        value: async () => (await evaluate((await get())[0], function getvalue() { return this.value; })).value,
        text: selectorText(get)
    };
}

/**
 * This {@link selector} lets you identify a combo box on a web page either with label or with attribute and value pairs.
 * Any value can be selected using value or text of the options.
 *
 * @example
 * comboBox('Vehicle:').select('Car')
 * comboBox('Vehicle:').value()
 * comboBox('Vehicle:').exists()
 *
 * @param {object} attrValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {string} label - The label (human-visible name) of the combo box.
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.comboBox = (attrValuePairs, ...args) => {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector,
        async () => await $$xpath(`//select[@id=(//label[contains(text(), ${xpath(selector.label)})]/@for)]`),
        'select');
    return {
        get: getIfExists(get),
        exists: exists(getIfExists(get)),
        description: desc(selector, 'label', 'Combobox'),
        select: async (value) => {

            const nodeId = (await get())[0];
            if (!nodeId) throw new Error('Combo Box not found');
            if (headful) await highlightElemOnAction(nodeId);

            function selectBox(value) {
                let found_value = false;
                for (var i = 0; i < this.options.length; i++) {
                    if (this.options[i].text === value || this.options[i].value === value) {
                        this.selectedIndex = i;
                        found_value = true;
                        let event = new Event('change');
                        this.dispatchEvent(event);
                        break;
                    }
                }
                return found_value;
            }
            const { object: { objectId } } = await dom.resolveNode({ nodeId });
            const options = setNavigationOptions({});
            await doActionAwaitingNavigation(options, async () => {
                const result = await runtime.callFunctionOn({
                    functionDeclaration: selectBox.toString(),
                    'arguments': [{ value: value }],
                    objectId
                });
                if (!result.result.value) throw new Error('Option not available in combo box');
            });
        },
        value: async () => (await evaluate((await get())[0], function getvalue() { return this.value; })).value,
        text: selectorText(get)
    };
};

/**
 * This {@link selector} lets you identify a checkbox on a web page either with label or with attribute and value pairs.
 *
 * @example
 * checkBox('Vehicle').check()
 * checkBox('Vehicle').uncheck()
 * checkBox('Vehicle').isChecked()
 * checkBox('Vehicle').exists()
 *
 * @param {object} attributeValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {string} label - The label (human-visible name) of the check box.
 * @param {...relativeSelector} args Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.checkBox = (attrValuePairs, ...args) => {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(selector,
        async () => await $$xpath(`//input[@type='checkbox'][@id=(//label[contains(text(), ${xpath(selector.label)})]/@for)]`),
        'input[type="checkbox"]');
    return {
        get: getIfExists(get),
        exists: exists(getIfExists(get)),
        description: desc(selector, 'label', 'Checkbox'),
        isChecked: async () => (await evaluate((await get())[0], function getvalue() { return this.checked; })).value,
        check: async () => {
            const options = setNavigationOptions({});
            await doActionAwaitingNavigation(options, async () => {
                if (headful) await highlightElemOnAction((await get())[0]);
                await evaluate((await get())[0], function getvalue() { this.checked = true; return true; });
            });
        },
        uncheck: async () => {
            const options = setNavigationOptions({});
            await doActionAwaitingNavigation(options, async () => {
                if (headful) await highlightElemOnAction((await get())[0]);
                await evaluate((await get())[0], function getvalue() { this.checked = false; return true; });
            });
        },
        text: selectorText(get)
    };
};

/**
 * This {@link selector} lets you identify a radio button on a web page either with label or with attribute and value pairs.
 *
 * @example
 * radioButton('Vehicle').select()
 * radioButton('Vehicle').deselect()
 * radioButton('Vehicle').isSelected()
 * radioButton('Vehicle').exists()
 *
 * @param {object} attributeValuePairs - Pairs of attribute and value like {"id":"name","class":"class-name"}
 * @param {string} label - The label (human-visible name) of the radio button.
 * @param {...relativeSelector} args
 * @returns {ElementWrapper}
 */
module.exports.radioButton = (attrValuePairs, ...args) => {
    validate();
    const selector = getValues(attrValuePairs, args);
    const get = getElementGetter(
        selector,
        async () => await $$xpath(`//input[@type='radio'][@id=(//label[contains(text(), ${xpath(selector.label)})]/@for)]`),
        'input[type="radio"]');
    return {
        get: getIfExists(get),
        exists: exists(getIfExists(get)),
        description: desc(selector, 'label', 'Radio Button'),
        isSelected: async () => (await evaluate((await get())[0], function getvalue() { return this.checked; })).value,
        select: async () => {
            const options = setNavigationOptions({});
            await doActionAwaitingNavigation(options, async () => {
                if (headful) await highlightElemOnAction((await get())[0]);
                await evaluate((await get())[0], function getvalue() { this.checked = true; return true; });
            });
        },
        deselect: async () => {
            const options = setNavigationOptions({});
            await doActionAwaitingNavigation(options, async () => {
                if (headful) await highlightElemOnAction((await get())[0]);
                await evaluate((await get())[0], function getvalue() { this.checked = false; return true; });
            });
        },
        text: selectorText(get)
    };
};

/**
 * This {@link selector} lets you identify an element with text.
 *
 * @example
 * highlight(text('Vehicle'))
 * text('Vehicle').exists()
 *
 * @param {string} text - Text to match.
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.text = (text, ...args) => {
    validate();
    const get = async () => await handleRelativeSearch(await elements(text), args);
    return { get: getIfExists(get), exists: exists(getIfExists(get)), description: `Element with text "${text}"`, text: selectorText(get) };
};

/**
 * This {@link selector} lets you identify an element containing the text.
 *
 * @example
 * contains('Vehicle').exists()
 *
 * @param {string} text - Text to match.
 * @param {...relativeSelector} args - Proximity selectors
 * @returns {ElementWrapper}
 */
module.exports.contains = contains;

function contains(text, ...args) {
    validate();
    assertType(text);
    const get = async (e = '*') => {
        let elements = await $$xpath('//' + e + `[contains(@value, ${xpath(text)})]`);
        if (!elements || !elements.length) elements = await $$xpath('//' + e + `[not(descendant::div) and contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), ${xpath(text.toLowerCase())})]`);
        return await handleRelativeSearch(elements, args);
    };
    return { get: getIfExists(get), exists: exists(getIfExists(get)), description: `Element containing text "${text}"`, text: selectorText(get) };
}

function match(text, ...args) {
    validate();
    assertType(text);
    const get = async (e = '*') => {
        let elements = await $$xpath('//' + e + `[@value=${xpath(text)}]`);
        if (!elements || !elements.length) {
            if (e === '*') elements = await $$xpath('//' + e + `[translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=${xpath(text.toLowerCase())}]`);
            else elements = await $$xpath('//' + e + `[translate(normalize-space(.//text()),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=${xpath(text.toLowerCase())}]`);
        }
        return await handleRelativeSearch(elements, args);
    };
    return { get: getIfExists(get), exists: exists(getIfExists(get)), description: `Element matching text "${text}"`, text: selectorText(get) };
}

/**
 * This {@link relativeSelector} lets you perform relative HTML element searches.
 *
 * @example
 * click(link("Block", toLeftOf("name"))
 *
 * @param {selector|string} selector - Web element selector.
 * @returns {RelativeSearchElement}
 */
module.exports.toLeftOf = selector => {
    validate();
    return new RelativeSearchElement(async (e, v) => {
        const rect = await domHandler.getBoundingClientRect(e);
        return rect.left < v;
    }, rectangle(selector, r => r.left), isString(selector) ? `To Left of ${selector}` : `To Left of ${selector.description}`);
};

/**
 * This {@link relativeSelector} lets you perform relative HTML element searches.
 *
 * @example
 * click(link("Block", toRightOf("name"))
 *
 * @param {selector|string} selector - Web element selector.
 * @returns {RelativeSearchElement}
 */
module.exports.toRightOf = selector => {
    validate();
    const value = rectangle(selector, r => r.right);
    const desc = isString(selector) ? `To Right of ${selector}` : `To Right of ${selector.description}`;
    return new RelativeSearchElement(async (e, v) => {
        const rect = await domHandler.getBoundingClientRect(e);
        return rect.right > v;
    }, value, desc);
};

/**
 * This {@link relativeSelector} lets you perform relative HTML element searches.
 *
 * @example
 * click(link("Block", above("name"))
 *
 * @param {selector|string} selector - Web element selector.
 * @returns {RelativeSearchElement}
 */
module.exports.above = selector => {
    validate();
    const desc = isString(selector) ? `Above ${selector}` : `Above ${selector.description}`;
    const value = rectangle(selector, r => r.top);
    return new RelativeSearchElement(async (e, v) => {
        const rect = await domHandler.getBoundingClientRect(e);
        return rect.top < v;
    }, value, desc);
};

/**
 * This {@link relativeSelector} lets you perform relative HTML element searches.
 *
 * @example
 * click(link("Block", below("name"))
 *
 * @param {selector|string} selector - Web element selector.
 * @returns {RelativeSearchElement}
 */
module.exports.below = selector => {
    validate();
    const desc = isString(selector) ? `Below ${selector}` : `Below ${selector.description}`;
    const value = rectangle(selector, r => r.bottom);
    return new RelativeSearchElement(async (e, v) => {
        const rect = await domHandler.getBoundingClientRect(e);
        return rect.bottom > v;
    }, value, desc);
};

/**
 * This {@link relativeSelector} lets you perform relative HTML element searches.
 *
 * @example
 * click(link("Block", near("name"))
 *
 * @param {selector|string} selector - Web element selector.
 * @returns {RelativeSearchElement}
 */
module.exports.near = (selector) => {
    validate();
    const desc = isString(selector) ? `Near ${selector}` : `Near ${selector.description}`;
    const value = rectangle(selector, r => r);
    return new RelativeSearchElement(async (e, v) => {
        const nearOffset = 30;
        const rect = await domHandler.getBoundingClientRect(e);
        return Math.abs(rect.bottom - v.bottom) < nearOffset || Math.abs(rect.top - v.top) < nearOffset ||
            Math.abs(rect.left - v.left) < nearOffset || Math.abs(rect.right - v.right) < nearOffset;
    }, value, desc);
};

/**
 * Lets you perform an operation when an `alert` with given text is shown.
 *
 * @example
 * alert('Message', async () => await dismiss())
 *
 * @param {string} message - Identify alert based on this message.
 * @param {function} callback - Operation to perform. Accept/Dismiss
 */
module.exports.alert = (message, callback) => dialog('alert', message, callback);

/**
 * Lets you perform an operation when a `prompt` with given text is shown.
 *
 * @example
 * prompt('Message', async () => await dismiss())
 *
 * @param {string} message - Identify prompt based on this message.
 * @param {function} callback - Operation to perform.Accept/Dismiss
 */
module.exports.prompt = (message, callback) => dialog('prompt', message, callback);

/**
 * Lets you perform an operation when a `confirm` with given text is shown.
 *
 * @example
 * confirm('Message', async () => await dismiss())
 *
 * @param {string} message - Identify confirm based on this message.
 * @param {function} callback - Operation to perform.Accept/Dismiss
 */
module.exports.confirm = (message, callback) => dialog('confirm', message, callback);

/**
 * Lets you perform an operation when a `beforeunload` with given text is shown.
 *
 * @example
 * beforeunload('Message', async () => await dismiss())
 *
 * @param {string} message - Identify beforeunload based on this message.
 * @param {function} callback - Operation to perform.Accept/Dismiss
 */
module.exports.beforeunload = (message, callback) => dialog('beforeunload', message, callback);

/**
 * Add interceptor for the network call to override request or mock response.
 *
 * @example
 * case 1: block url => intercept(url)
 * case 2: mockResponse => intercept(url,{mockObject})
 * case 3: override request => intercept(url,(request) => {request.continue({overrideObject})})
 * case 4: redirect => intercept(url,redirectUrl)
 * case 5: mockResponse based on request => intercept(url,(request) => { request.respond({mockResponseObject})} )
 *
 * @param {string} requestUrl request URL to intercept
 * @param {function|object}option action to be done after interception. For more examples refer to https://github.com/getgauge/taiko/issues/98#issuecomment-42024186
 * @returns {object} Object with the description of the action performed.
 */
module.exports.intercept = async (requestUrl, option) => {
    await networkHandler.addInterceptor({ requestUrl: requestUrl, action: option });
    return { description: `Interceptor added for ${requestUrl}` };
};

/**
 * Evaluates script on element matching the given selector.
 *
 * @example
 * evaluate(link("something"), (element) => element.style.backgroundColor)
 * evaluate(()=>{return document.title})
 *
 * @param {selector|string} selector - Web element selector.
 * @param {function} callback - callback method to execute on the element.
 * @param {Object} options - Click options.
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the click. Default navigation timeout is 15 seconds, to override pass `{ timeout: 10000 }` in `options` parameter.
 * @param {number} [options.waitForStart=500] - wait for navigation to start. Default to 500ms
 * @param {number} [options.timeout=5000] - Timeout value in milliseconds for navigation after click.
 * @returns {Promise<Object>} Object with description of action performed and return value of callback given
 */
module.exports.evaluate = async (selector, callback, options = {}) => {
    let result;
    if (isFunction(selector)) {
        callback = selector;
        selector = (await $$xpath('//*'))[0];
    }
    const nodeId = isNaN(selector) ? await element(selector) : selector;
    if (headful) await highlightElemOnAction(nodeId);

    async function evalFunc(callback) {
        let fn;
        eval(`fn = ${callback}`);
        return await fn(this);
    }
    const { object: { objectId } } = await dom.resolveNode({ nodeId });
    options = setNavigationOptions(options);
    await doActionAwaitingNavigation(options, async () => {
        result = await runtime.callFunctionOn({
            functionDeclaration: evalFunc.toString(),
            arguments: [{ value: callback.toString() }],
            awaitPromise: true,
            returnByValue: true,
            objectId
        });
    });
    return { description: 'Evaluated given script. Result: ' + result.result.value, result: result.result.value };
};

/**
 * Converts seconds to milliseconds.
 *
 * @example
 * link('Plugins').exists(intervalSecs(1))
 *
 * @param {number} secs - Seconds to convert.
 * @return {number} - Milliseconds.
 */
module.exports.intervalSecs = secs => secs * 1000;

/**
 * Converts seconds to milliseconds.
 *
 * @example
 * link('Plugins').exists(intervalSecs(1), timeoutSecs(10))
 *
 * @param {number} secs - Seconds to convert.
 * @return {number} - Milliseconds.
 */
module.exports.timeoutSecs = secs => secs * 1000;

/**
 * This function is used to improve the readability. It simply returns the parameter passed into it.
 *
 * @example
 * attach('c:/abc.txt', to('Please select a file:'))
 *
 * @param {string|selector}
 * @return {string|selector}
 */
module.exports.to = e => e;

/**
 * This function is used to improve the readability. It simply returns the parameter passed into it.
 *
 * @example
 * write("user", into('Username:'))
 *
 * @param {string|selector}
 * @return {string|selector}
 */
module.exports.into = e => e;

/**
 * This function is used to wait for number of secs given.
 *
 * @example
 * waitFor(intervalSecs(5))
 *
 * @param {number|time}
 * @return {promise}
 */
module.exports.waitFor = waitFor;

/**
 * Accept callback for dialogs
 */
module.exports.accept = async () => {
    await page.handleJavaScriptDialog({
        accept: true,
    });
    return { description: 'Accepted dialog' };
};

/**
 * Dismiss callback for dialogs
 */
module.exports.dismiss = async () => {
    await page.handleJavaScriptDialog({
        accept: false
    });
    return { description: 'Dismissed dialog' };
};

const setRootId = () => {
    return new Promise(function waitForRootId(resolve) {
        if (rootId !== null) {
            resolve();
        } else setTimeout(() => { waitForRootId(resolve); }, 500).unref();
    });
};

const doActionAwaitingNavigation = async (options, action) => {
    const promises = [];
    const loadEventPromise = new Promise((resolve) => {
        xhrEvent.addListener('loadEventFired', resolve);
    });
    const targetPromise = new Promise((resolve) => {
        xhrEvent.addListener('targetNavigated', resolve);
    });
    const paintPromise = new Promise((resolve) => {
        xhrEvent.addListener('firstMeaningfulPaint', resolve);
    });
    const networkIdlePromise = new Promise((resolve) => {
        xhrEvent.addListener('networkIdle', resolve);
    });

    let func = addPromiseToWait(promises);
    const loadListener = () => {
        promises.push(loadEventPromise);
        promises.push(page.frameStoppedLoading());
    };
    xhrEvent.addListener('xhrEvent', func);
    xhrEvent.once('xhrEvent',()=>promises.push(networkIdlePromise));
    xhrEvent.once('frameStartedLoading', loadListener);
    xhrEvent.once('targetCreated', () => promises.push(targetPromise));
    xhrEvent.once('firstPaint', () => promises.push(paintPromise));
    await action();
    await waitForPromises(promises, options.waitForStart);
    if (options.awaitNavigation) {
        //TODO:Handle frame load without loadEventFired
        await waitForNavigation(options.timeout, promises).catch(() => { });
    }
    xhrEvent.removeAllListeners();
};

const waitForPromises = (promises, waitForStart) => {
    return Promise.race([waitFor(waitForStart), new Promise(function waitForPromise(resolve) {
        if (promises.length) {
            resolve();
        } else setTimeout(() => { waitForPromise(resolve); }, waitForStart / 5).unref();
    })]);
};

const addPromiseToWait = (promises) => {
    return (promise) => {
        promises.push(promise);
    };
};

const waitForNavigation = (timeout, promises = []) => {
    promises.push(setRootId());
    return new Promise((resolve, reject) => {
        Promise.all(promises).then(resolve);
        setTimeout(() => reject('Timedout'), timeout).unref();
    });
};

const handleTimeout = (timeout) => {
    return (e) => {
        xhrEvent.removeAllListeners();
        if (e === 'Timedout')
            throw new Error(`Navigation took more than ${timeout}ms. Please increase the timeout.`);
    };
};

const highlightElemOnAction = async (elem) => {
    const result = await domHandler.getBoxModel(elem);
    await overlay.highlightQuad({ quad: result.model.border, outlineColor: { r: 255, g: 0, b: 0 } });
    await waitFor(1000);
    await overlay.hideHighlight();
};

const element = async (selector, tag) => (await elements(selector, tag))[0];

const elements = async (selector, tag) => {
    const elements = await (() => {
        if (isString(selector)) {
            return match(selector).get(tag);
        } else if (isSelector(selector)) {
            return selector.get(tag);
        }
        return null;
    })();
    if (!elements || !elements.length) {
        const error = isString(selector) ? `Element with text ${selector} not found` :
            `${selector.description} not found`;
        throw new Error(error);
    }
    return elements;
};

const description = (selector, lowerCase = false) => {
    const d = (() => {
        if (isString(selector)) return contains(selector).description;
        else if (isSelector(selector)) return selector.description;
        return '';
    })();
    return lowerCase ? d.charAt(0).toLowerCase() + d.slice(1) : d;
};

const _focus = async selector => {
    await scrollTo(selector);

    function focusElement() {
        this.focus();
        return true;
    }
    await evaluate(selector, focusElement);
};

const dialog = (dialogType, dialogMessage, callback) => {
    validate();
    page.javascriptDialogOpening(async ({ message, type }) => {
        if (dialogType === type && dialogMessage === message)
            await callback();
    });
};

const isSelector = obj => obj['get'] && obj['exists'];

const filter_visible_nodes = async (nodeIds) => {
    let visible_nodes = [];

    function isHidden() {
        return this.offsetParent === null;
    }

    for (const nodeId of nodeIds) {
        const result = await evaluate(nodeId, isHidden);
        if (!result.value) visible_nodes.push(nodeId);
    }

    return visible_nodes;
};

const $$ = async selector => {
    const { nodeIds } = await dom.querySelectorAll({ nodeId: rootId, selector: selector });
    return (await filter_visible_nodes(nodeIds));
};

const $$xpath = async selector => {
    const { searchId, resultCount } = await dom.performSearch({
        query: selector
    });
    if (resultCount === 0) return;
    const { nodeIds } = await dom.getSearchResults({
        searchId,
        fromIndex: 0,
        toIndex: resultCount
    });
    return (await filter_visible_nodes(nodeIds));
};

const evaluate = async (selector, func) => {
    let nodeId = selector;
    if (isNaN(selector)) nodeId = await element(selector);
    const { object: { objectId } } = await dom.resolveNode({ nodeId });
    const { result } = await runtime.callFunctionOn({
        functionDeclaration: func.toString(),
        objectId
    });
    return result;
};

const validate = () => {
    if (!dom || !page) throw new Error('Browser or page not initialized. Call `openBrowser()` before using this API');
};

const assertType = (obj, condition = isString, message = 'String parameter expected') => {
    if (!condition(obj)) throw new Error(message);
};

const sleep = milliseconds => {
    var start = new Date().getTime();
    for (var i = 0; i < 1e7; i++)
        if ((new Date().getTime() - start) > milliseconds) break;
};

const selectorText = get => {
    return async () => {
        const texts = [];
        const elems = await getIfExists(get)();
        for (const elem of elems) {
            texts.push((await evaluate(elem, function getText() { return this.innerText; })).value);
        }
        return texts;
    };
};

const exists = get => {
    return async () => {
        if ((await get()).length) return { description: 'Exists' };
        return { description: 'Does not exist' };
    };
};

const getIfExists = get => {
    return async (tag, intervalTime = 1000, timeout = 10000) => {
        try {
            await waitUntil(async () => (await get(tag)).length > 0, intervalTime, timeout);
            return await get(tag);
        } catch (e) {
            return [];
        }
    };
};

const waitUntil = async (condition, intervalTime, timeout) => {
    var start = new Date().getTime();
    while (true) {
        try {
            if (await condition()) break;
        } catch (e) { }
        if ((new Date().getTime() - start) > timeout)
            throw new Error(`waiting failed: timeout ${timeout}ms exceeded`);
        sleep(intervalTime);
    }
};

const xpath = s => `concat(${s.match(/[^'"]+|['"]/g).map(part => {
    if (part === '\'') return '"\'"';
    if (part === '"') return '\'"\'';
    return '\'' + part + '\'';
}).join(',') + ', ""'})`;

const rectangle = async (selector, callback) => {
    const elems = await elements(selector);
    let results = [];
    for (const e of elems) {
        const r = await domHandler.getBoundingClientRect(e);
        results.push({ elem: e, result: callback(r) });
    }
    return results;
};

const isRelativeSearch = args => args.every(a => a instanceof RelativeSearchElement);

const getMatchingNode = async (elements, args) => {
    const matchingNodes = [];
    for (const element of elements) {
        let valid = true;
        let dist = 0;
        for (const arg of args) {
            const relativeNode = await arg.validNodes(element);
            if (relativeNode === undefined) {
                valid = false;
                break;
            }
            dist += relativeNode.dist;
        }
        if (valid) matchingNodes.push({ element: element, dist: dist });
    }
    matchingNodes.sort(function (a, b) {
        return a.dist - b.dist;
    });
    return matchingNodes;
};

const handleRelativeSearch = async (elements, args) => {
    if (!args.length) return elements;
    if (!isRelativeSearch(args)) throw new Error('Invalid arguments passed, only relativeSelectors are accepted');
    const matchingNodes = await getMatchingNode(elements, args);
    return Array.from(matchingNodes, node => node.element);
};

/**
 * Identifies an element on the page.
 * @callback selector
 * @function
 * @example
 * link('Sign in')
 * button('Get Started')
 * $('#id')
 * text('Home')
 *
 * @param {string} text - Text to identify the element.
 * @param {...string} args
 */

/**
 * Lets you perform relative HTML element searches.
 * @callback relativeSelector
 * @function
 * @example
 * near('Home')
 * toLeftOf('Sign in')
 * toRightOf('Get Started')
 * above('Sign in')
 * below('Home')
 * link('Sign In',near("Home"),toLeftOf("Sign Out")) - Multiple selectors can be used to perform relative search
 *
 * @param {selector|string} selector - Web element selector.
 * @returns {RelativeSearchElement}
 */

/**
 * Represents a relative HTML element search. This is returned by {@link relativeSelector}
 *
 * @example
 * // returns RelativeSearchElement
 * above('username')
 *
 * @typedef {Object} RelativeSearchElement
 */
class RelativeSearchElement {
    /**
     * @class
     * @ignore
     */
    constructor(condition, value, desc) {
        this.condition = condition;
        this.value = value;
        this.desc = desc;
    }

    async validNodes(nodeId) {
        let matchingNode, minDiff = Infinity;
        const results = await this.value;
        for (const result of results) {
            if (await this.condition(nodeId, result.result)) {
                const diff = await domHandler.getPositionalDifference(nodeId, result.elem);
                if (diff < minDiff) {
                    minDiff = diff;
                    matchingNode = { elem: result.elem, dist: diff };
                }
            }
        }
        return matchingNode;
    }

    toString() {
        return this.desc;
    }
}

/**
 * Wrapper object for the element present on the web page. Extra methods are avaliable based on the element type.
 *
 * * `get()`, `exists()`, `description`, text() for all the elements.
 * * `value()` for input field, fileField and text field.
 * * `value()`, `select()` for combo box.
 * * `check()`, `uncheck()`, `isChecked()` for checkbox.
 * * `select()`, `deselect()`, `isSelected()` for radio button.
 *
 * @typedef {Object} ElementWrapper
 * @property @private {function} get - DOM element getter. Implicitly wait for the element to appears with timeout of 10 seconds.
 * @property {function(number, number)} exists - Checks existence for element.
 * @property {string} description - Describing the operation performed.
 * @property {Array} text - Gives innerText of all matching elements.
 *
 * @example
 * link('google').exists()
 * link('google').exists(intervalSecs(1), timeoutSecs(10))
 * link('google').description
 * textField('username').value()
 * $('.class').text()
 */
const realFuncs = {};
for(const func in module.exports){
    realFuncs[func] = module.exports[func];
    if (realFuncs[func].constructor.name === 'AsyncFunction')
        module.exports[func] = async function(){
            if(observe){await waitFor(observeTime);}
            return await realFuncs[func].apply(this, arguments);
        };
}

module.exports.metadata = {
    'Browser actions': ['openBrowser', 'closeBrowser', 'client', 'switchTo', 'setViewPort', 'openTab', 'closeTab'],
    'Page actions': ['goto', 'reload', 'title', 'click', 'doubleClick', 'rightClick', 'hover', 'focus', 'write', 'clear', 'attach', 'press', 'highlight', 'scrollTo', 'scrollRight', 'scrollLeft', 'scrollUp', 'scrollDown', 'screenshot'],
    'Selectors': ['$', 'image', 'link', 'listItem', 'button', 'inputField', 'fileField', 'textField', 'comboBox', 'checkBox', 'radioButton', 'text', 'contains'],
    'Proximity selectors': ['toLeftOf', 'toRightOf', 'above', 'below', 'near'],
    'Events': ['alert', 'prompt', 'confirm', 'beforeunload', 'intercept'],
    'Helpers': ['evaluate', 'intervalSecs', 'timeoutSecs', 'to', 'into', 'waitFor', 'accept', 'dismiss']
};
