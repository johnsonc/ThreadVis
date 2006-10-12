/** ****************************************************************************
 * ThreadVis.js
 *
 * (c) 2005-2006 Alexander C. Hubmann
 *
 * JavaScript file for Mozilla part of ThreadVis Extension
 *
 * Version: $Id$
 ******************************************************************************/


var HTML_NAMESPACE_ =
    "http://www.w3.org/1999/xhtml";
var XUL_NAMESPACE_ =
    "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

var THREADVIS_ = null;
var LOGGER_ = null;
var PREFERENCE_OBSERVER_ = null;
var THREADVIS_PARENT_ = null;
var THREADVIS_ENABLED_ = false;
var THREADVIS_DISABLEDACCOUNTS_ = "";
var THREADVIS_DISABLEDFOLDERS_ = new Array();
var COPY_MESSAGE_ = null;
var POPUP_WINDOW_ = null;

// add visualisation at startup
addEventListener("load", createThreadVis, false);



/** ****************************************************************************
 * create one and only one threadvis object
 ******************************************************************************/
function createThreadVis()
{
    // create preference observer
    var preference_observer = checkForPreferenceObserver(window);
    if (preference_observer)
    {
        PREFERENCE_OBSERVER_ = preference_observer;
    }
    else
    {
        PREFERENCE_OBSERVER_ = new PreferenceObserver();
        PREFERENCE_OBSERVER_.registerCallback("enabled", preferenceEnabledChanged);
        PREFERENCE_OBSERVER_.registerCallback("disabledaccounts", preferenceDisabledAccountsChanged);
        PREFERENCE_OBSERVER_.registerCallback("disabledfolders", preferenceDisabledFoldersChanged);
    }

    THREADVIS_ENABLED_ = PREFERENCE_OBSERVER_.getPreference("enabled");
    THREADVIS_DISABLEDACCOUNTS_ = PREFERENCE_OBSERVER_.getPreference("disabledaccounts");
    THREADVIS_DISABLEDFOLDERS_ = PREFERENCE_OBSERVER_.getPreference("disabledfolders");

    if (! THREADVIS_ENABLED_)
    {
        deleteBox();
        return;
    }

    createBox();

    // check for any opener and logger in that opener
    var logger = checkForLogger(window);
    if (logger)
        LOGGER_ = logger;
    else
        LOGGER_ = new Logger();

    THREADVIS_PARENT_ = checkForThreadVis(window);
    if (THREADVIS_ == null)
        THREADVIS_ = new ThreadVis();
}



/** ****************************************************************************
 * Check all openers for loggers
 ******************************************************************************/
function checkForLogger(win)
{
    if (! win)
        return null;

    if (win.LOGGER_)
        return win.LOGGER_;
    if (win.opener)
        return checkForLogger(win.opener);

    return null;
}



/** ****************************************************************************
 * Check all openers for threadvis
 ******************************************************************************/
function checkForThreadVis(win)
{
    if (! win)
        return null;

    if (win.THREADVIS_)
        return win.THREADVIS_;

    if (win.THREADVIS_PARENT_)
        return win.THREADVIS_PARENT_;

    if (win.opener)
        return checkForThreadVis(win.opener);

    return null;
}



/** ****************************************************************************
 * Check all openers for preference observer
 ******************************************************************************/
function checkForPreferenceObserver(win)
{
    if (! win)
        return null;

    if (win.PREFERENCE_OBSERVER_)
        return win.PREFERENCE_OBSERVER_;
    if (win.opener)
        return checkForPreferenceObserver(win.opener);

    return null;
}



/** ****************************************************************************
 * Open the options dialog for this extension
 ******************************************************************************/
function openThreadVisOptionsDialog()
{
    if (typeof(openOptionsDialog) == "undefined")
    {
        // Mozilla doesn't know about openOptionsDialog, so we use goPreferences.
        // Although Thunderbird also knows goPreferences, Thunderbird 1.5
        // has some problems with it, so we use it only for Mozilla and use
        // openOptionsDialog for Thunderbird. For details see comments below.
        goPreferences('threadvis', 'chrome://threadvis/content/Settings.xul','threadvis');
    }
    else
    {
        // Thunderbird knows both goPreferences and openOptionsDialog
        // but Thunderbird 1.5 (Beta) doesn't do well with goPreferences.
        // It opens a window, but it has no content.
        // 
        // Also almost all calls to open the preferences window use
        // openOptionsDialog in 1.5, so we might as well use it too.
        //
        // One problem remains:
        //
        // # In Thunderbird < 1.5, the function is defined as
        //     function openOptionsDialog(containerID, paneURL, itemID)
        // # whereas in Thunderbird 1.5, it is defined as
        //     function openOptionsDialog(aPaneID, aTabID)
        //
        // And I don't know how to distinguish between those two.
        // So let's do a bad hack and pass the aPaneID as the first
        // parameter (which seems to do no harm to Thunderbird < 1.5) and
        // pass the paneURL as the second parameter (which in turn seems to
        // do no harm to Thunderbird 1.5).
        //
        // NOTE:
        // Additionally, Thunderbird 1.5 uses a completely new layout and API 
        // for the preferences window, which leads to the problem that we need to
        // have two separate XUL files to edit the preferences for this extension.
        //
        // So we have Settings15.xul which gets used in Thunderbird 1.5 (and 
        // which defines the paneThreadVis component which gets passed as
        // aPaneID), and we have Settings.xul which gets used in Thunderbird < 1.5
        // and Mozilla (which URL gets passed as paneURL).
        openOptionsDialog('paneThreadVis', 'chrome://threadvis/content/Settings.xul');
    }
}



/** ****************************************************************************
 * constructor
 ******************************************************************************/
function ThreadVis()
{
    LOGGER_.log("threadvis",
                    {"action": "startup"});

    // synchronization variables
    this.loaded_ = false;
    this.loading_ = false;
    this.threaded_ = false;
    this.threading_ = false;
    this.clear_ = false;

    // store server to react to server switch
    this.server_ = null;

    // visualisation object
    this.visualisation_ = new Visualisation();
    this.clearVisualisation();

    // threader object
    if (THREADVIS_PARENT_)
    {
        this.threader_ = THREADVIS_PARENT_.threader_;
        this.loaded_ = THREADVIS_PARENT_.loaded_;
        this.threaded_ = THREADVIS_PARENT_.threaded_;
        this.server_ = THREADVIS_PARENT_.server_;
        
        // visualise selected message
        this.visualise(THREADVIS_PARENT_.selected_container_);
        return;
    }
    else
        this.threader_= new Threader();

    // remember msgkey of selected message
    this.selected_msgkey_ = "";

    // remember container of selected message
    this.selected_container_ = null;

    this.add_messages_from_folder_enumerator_maxcounter_ = 100;


    // add messages when we display first header
    // register this as event handler later
    var ref = this;
    this.doLoad = {
        onStartHeaders: function()
        {
            ref.initMessages();
            ref.waitForThreading();
            ref.setSelectedMessage();
        },
        onEndHeaders: function()
        {
        }
    }
    gMessageListeners.push(this.doLoad);

    // add folder listener, so that we can add newly received
    // messages
    this.folderListener =
    {
        OnItemAdded: function(parentItem, item, view)
        {
            // this is called
            // POP:  - when new msgs arrive
            //       - when moving messages from one folder to another
            // IMAP: - only when new msgs arrive
            //       - NOT when moving messages!!
            ref.onItemAdded(parentItem, item, view);
        },

        OnItemRemoved: function(parentItem, item, view)
        {
            // removed item from folder
            //ref.onItemRemoved(parentItem, item, view);
        },

        OnItemPropertyChanged: function(item, property, oldValue, newValue) {},
        OnItemIntPropertyChanged: function(item, property, oldValue, newValue) {},
        OnItemBoolPropertyChanged: function(item, property, oldValue, newValue) {},
        OnItemUnicharPropertyChanged: function(item, property, oldValue, newValue) {},
        OnItemPropertyFlagChanged: function(item, property, oldFlag, newFlag) {},
        OnItemEvent: function(folder, event) {}
    }
    if (! this.gMailSession)
        this.gMailSession = Components.classes["@mozilla.org/messenger/services/session;1"].getService(Components.interfaces.nsIMsgMailSession);
    var notifyFlags = Components.interfaces.nsIFolderListener.all;
    this.gMailSession.AddFolderListener(this.folderListener, notifyFlags);

    addEventListener("unload",
                     function() {ref.unloadHandler()},
                     false);
}



/** ****************************************************************************
 * Add a message to the threader
 ******************************************************************************/
ThreadVis.prototype.addMessage = function(header)
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return


    LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.addMessage()", {});
    var date = new Date();
    // PRTime is in microseconds, Javascript time is in milliseconds
    // so divide by 1000 when converting
    date.setTime(header.date / 1000);

    var message = new Message(header.mime2DecodedSubject,
                              header.mime2DecodedAuthor,
                              header.messageId,
                              header.messageKey,
                              date,
                              header.folder.URI ,
                              header.getStringProperty("references"),
                              false);

    // see if msg is a sent mail
    var issent = IsSpecialFolder(header.folder,
                                 MSG_FOLDER_FLAG_SENTMAIL,
                                 true) ||
                 this.account_.defaultIdentity.email == message.getFromEmail();

    message.setSent(issent);
    this.threader_.addMessage(message);
}



/** ****************************************************************************
 * Add all messages from current account
 ******************************************************************************/
ThreadVis.prototype.addMessages = function()
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return;

    LOGGER_.log("addmessages", {"action" : "start"});
    this.add_messages_start_time = new Date();
    this.loading_ = true;
    this.loaded_ = false;

    this.add_messages_done_ = false;

    // get root folder
    var folder = GetLoadedMsgFolder();
    var root = folder.rootFolder;

    this.server_ = folder.server;
    this.account_ = (Components.classes["@mozilla.org/messenger/account-manager;1"]
                    .getService(Components.interfaces.nsIMsgAccountManager))
                    .FindAccountForServer(this.server_);

    this.folders_ = new Array();
    this.getAllFolders(root);

    this.waitForAddMessages();
}



/** ****************************************************************************
 * Add all messages in this folder
 ******************************************************************************/
ThreadVis.prototype.addMessagesFromFolder = function(folder)
{
    if (! THREADVIS_ENABLED_)
        return;

    if (! this.checkEnabledAccountOrFolder(folder))
    {
        this.add_messages_from_folder_done_ = true;
        this.add_messages_from_folder_doing_ = false;
        return;
    }

    if (this.add_messages_from_folder_done_)
    {
        LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.addMessagesFromFolder()",
                            {"folder" : folder.URI,
                             "action" : "end"});
        return;
    }

    LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.addMessagesFromFolder()",
                        {"folder" : folder.URI,
                         "action" : "start"});

    // get messages from current folder
    try
    {
        var msg_enumerator = folder.getMessages(null);
    }
    catch (exception)
    {
        LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.addMessagesFromFolder()",
                            {"folder" : folder.URI,
                             "action" : "caught exception " + exception});
        this.add_messages_from_folder_done_ = true;
        this.add_messages_from_folder_doing_ = false;
        return;
    }
    
    this.add_messages_from_folder_doing_ = true;
    var ref = this;
    this.add_messages_from_folder_enumerator_counter_ = 0;
    setTimeout(function(){ref.addMessagesFromFolderEnumerator(msg_enumerator);}, 10);
}



/** ****************************************************************************
 * Add all messages from this enumerator
 * do a setTimeout call every this.add_messages_from_folder_enumerator_maxcounter_ messages
 * to give ui time to do its thing
 ******************************************************************************/
ThreadVis.prototype.addMessagesFromFolderEnumerator = function(enumerator)
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return


    LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.addMessagesFromFolderEnumerator()", {"action" : "start"});
    var header = null;
    while (enumerator.hasMoreElements())
    {
        this.add_messages_from_folder_enumerator_counter_++;
        if (this.add_messages_from_folder_enumerator_counter_ >= this.add_messages_from_folder_enumerator_maxcounter_)
        {
            LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.addMessagesFromFolderEnumerator()", {"action" : "pause"});
            var ref = this;
            this.add_messages_from_folder_enumerator_counter_ = 0;
            setTimeout(function() {ref.addMessagesFromFolderEnumerator(enumerator);}, 10);
            return;
        }

        header = enumerator.getNext();
        if (header instanceof Components.interfaces.nsIMsgDBHdr)
        {
            this.addMessage(header);
        }
    }

    LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.addMessagesFromFolderEnumerator()",
                        {"action" : "end"});
    this.add_messages_from_folder_done_ = true;
    this.add_messages_from_folder_doing_ = false;
}



/** ****************************************************************************
 * Callback function from extension
 * called after mouse click in extension
 * select message in mail view
 ******************************************************************************/
ThreadVis.prototype.callback = function(msg_key,
                                         folder)
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return


    LOGGER_.log("msgselect",
                    {"from" : "extension",
                     "key" : msg_key});

    this.selected_msgkey_ = msg_key;

    // get folder for message
    this.getMainWindow().SelectFolder(folder);

    // clear current selection
    var tree = this.getMainWindow().GetThreadTree();
    
    var treeBoxObj = tree.treeBoxObject;
    // this is necessary because Thunderbird >= 1.5 uses
    // tree.view.selection
    // and
    // tree.treeBoxObject.selection
    // doesn't work anymore
    var treeSelection = null;
    if (tree.view)
        treeSelection = tree.view.selection;
    else
        treeSelection = treeBoxObj.selection;

    treeSelection.clearSelection();

    // select message
    this.getMainWindow().gDBView.selectMsgByKey(msg_key);

    treeBoxObj.ensureRowIsVisible(treeSelection.currentIndex);
}



/** ****************************************************************************
 * Check if current account is enabled in extension
 ******************************************************************************/
ThreadVis.prototype.checkEnabledAccountOrFolder = function(folder)
{
    if (! folder)
        folder = this.getMainWindow().GetLoadedMsgFolder();

    if (! folder)
        return false;

    var server = folder.server;
    var account = (Components.classes["@mozilla.org/messenger/account-manager;1"]
                   .getService(Components.interfaces.nsIMsgAccountManager))
                   .FindAccountForServer(server);

    var regexp_account = new RegExp(account.key);

    if (THREADVIS_DISABLEDACCOUNTS_ != "" && 
        THREADVIS_DISABLEDACCOUNTS_.match(regexp_account))
    {
        LOGGER_.logDebug(LOGGER_.LEVEL_INFORM_, "accountdisabled",
                            {"total_regexp" : THREADVIS_DISABLEDACCOUNTS_,
                             "this_account" : account.key});
        return false;
    }
    else
    {
        var regexp_folder = new RegExp(folder.URI + " ");
        if (THREADVIS_DISABLEDFOLDERS_ != "" && 
            THREADVIS_DISABLEDFOLDERS_.match(regexp_folder))
        {
            LOGGER_.logDebug(LOGGER_.LEVEL_INFORM_, "folderdisabled",
                                {"total_regexp" : THREADVIS_DISABLEDFOLDERS_,
                                "this_folder" : folder.URI});
            return false;
        }
        else
        {
            return true;
        }
    }
}



/** ****************************************************************************
 * clear visualisation
 ******************************************************************************/
ThreadVis.prototype.clearVisualisation = function()
{
    LOGGER_.logDebug(LOGGER_.LEVEL_VIS_, "ThreadVis.clearVisualisation()", {"clear" : this.clear_});

    if (! THREADVIS_ENABLED_ )
    {
        return;
    }

    if (this.clear_)
        return;

    this.visualisation_.createStack();
    this.clear_ = true;
}



/** ****************************************************************************
 * create threadvis xul box
 ******************************************************************************/
function createBox()
{
    if (document.getElementById("ThreadVisBox"))
        return;

    var box = document.createElementNS(XUL_NAMESPACE_, "vbox");
    box.setAttribute("id", "ThreadVisBox");
    box.setAttribute("minheight", 50);
    box.setAttribute("minwidth", 200);
    box.setAttribute("flex", 2);
    box.setAttribute("align", "right");
    box.setAttribute("context", "ThreadVisPopUp");
    
    var headerbox = document.getElementById("expandedHeaderView");
    headerbox.appendChild(box);
}



/** ****************************************************************************
 * delete threadvis xul box
 ******************************************************************************/
function deleteBox()
{
    var box = document.getElementById("ThreadVisBox");
    if (! box)
        return;

    var headerbox = document.getElementById("expandedHeaderView");
    headerbox.removeChild(box);
}



/** ****************************************************************************
 * thread all messages
 ******************************************************************************/
ThreadVis.prototype.doThreading = function()
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return


    LOGGER_.logDebug(LOGGER_.LEVEL_INFORM_, "ThreadVis.doThreading()", {});
    if (! this.threading_ && ! this.threaded_)
    {
        this.threading_ = true;
        this.threaded_ = false;
        this.threader_.thread();
    }
    if (this.threading_)
    {
        var done = this.threader_.getDone();
        if (done)
        {
            this.threaded_ = true;
            this.threading_ = false;
            return;
        }
    var ref = this;
    setTimeout(function(){ref.doThreading();}, 100);
    }
}



/** ****************************************************************************
 * Build a list of all folders to add messages from
 ******************************************************************************/
ThreadVis.prototype.getAllFolders = function(folder)
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return


    LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.getAllFolders()",
                        {"folder" : folder.URI});
    var folder_enumerator = folder.GetSubFolders();
    var current_folder = null;
    while (true)
    {
        try
        {
            current_folder = folder_enumerator.currentItem();
        }
        catch (Exception)
        {
            break;
        }

        if (current_folder instanceof Components.interfaces.nsIMsgFolder)
            this.folders_.push(current_folder);

        if (current_folder.hasSubFolders)
            this.getAllFolders(current_folder);

        try
        {
            folder_enumerator.next();
        }
        catch (Exception)
        {
            break;
        }
    }
}



/** ****************************************************************************
 * Return main window object
******************************************************************************/
ThreadVis.prototype.getMainWindow = function()
{
    var w = window;
    
    while (w != null)
    {
        if (typeof(w.GetThreadTree) == "function")
            return w;
        
        w = window.opener;
    }
}



/** ****************************************************************************
 * add all messages
 * if not already done
 ******************************************************************************/
ThreadVis.prototype.initMessages = function()
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return


    LOGGER_.logDebug(LOGGER_.LEVEL_INFORM_, "ThreadVis.initMessages()", {});
    if (! this.loaded_ && ! this.loading_)
    {
        this.loading_ = true;
        var ref = this;
        setTimeout(function(){ref.addMessages();}, 100);
    }
}



/** ****************************************************************************
 * called when new folder added
 ******************************************************************************/
ThreadVis.prototype.onFolderAdded = function(folder)
{
    if (! this.checkEnabledAccountOrFolder(folder))
        return
    
    if (! this.loaded_)
        return;
    
    if (this.add_messages_from_folder_doing_)
        return;
    
    var start = new Date();
    LOGGER_.log("addadditionalmessagesfolder", {"action" : "start"});
    // added new message to folder
    if (folder instanceof Components.interfaces.nsIMsgFolder)
    {
        this.add_messages_from_folder_done_ = false;
        this.add_messages_from_folder_doing_ = false;
        this.addMessagesFromFolder(folder);
        this.onFolderAddedWaitForThreading();
    }
    var end = new Date();
    var duration = end - start;
    LOGGER_.log("addadditionalmessagesfolder", {"action" : "end", "time" : duration});
}



/** ****************************************************************************
 * called to wait to thread new folder
 ******************************************************************************/
ThreadVis.prototype.onFolderAddedWaitForThreading = function()
{
    if (this.add_messages_from_folder_done_)
    {
        this.threader_.thread();
        this.onFolderAddedWaitForVisualisation();
        return;
    }
    else
    {
        var ref = this;
        setTimeout(function(){ref.onFolderAddedWaitForThreading();}, 10);
    }
}



/** ****************************************************************************
 * called to wait to thread new folder
 ******************************************************************************/
ThreadVis.prototype.onFolderAddedWaitForVisualisation = function()
{
    if (this.threader_.getDone())
    {
        this.setSelectedMessage()
        return;
    }
    else
    {
        var ref = this;
        setTimeout(function(){ref.onFolderAddedWaitForVisualisation();}, 10);
    }
}



/** ****************************************************************************
 * called when new messages arrive
 * either from server or moved from one folder to the other (only POP!!)
 ******************************************************************************/
ThreadVis.prototype.onItemAdded = function(parentItem, item, view)
{
    var start = new Date();
    LOGGER_.log("addadditionalmessages", {"action" : "start"});
    // added new message to folder
    if (item instanceof Components.interfaces.nsIMsgDBHdr)
    {
        this.addMessage(item);
        this.threader_.thread();
    }
    var end = new Date();
    var duration = end - start;
    LOGGER_.log("addadditionalmessages", {"action" : "end", "time" : duration});
}



/** ****************************************************************************
 * called when messages are deleted
 * not called at the moment
 ******************************************************************************/
ThreadVis.prototype.onItemRemoved = function(parentItem, item, view)
{
    var start = new Date();
    LOGGER_.log("deletemessage", {"action" : "start"});
    // added new message to folder
    if (item instanceof Components.interfaces.nsIMsgDBHdr)
    {
        var container = this.threader_.findContainer(item.messageId);
        if (container)
        {
            container.setMessage(null);
        }
    }
    var end = new Date();
    var duration = end - start;
    LOGGER_.log("deletemessage", {"action" : "end", "time" : duration});
}



/** ****************************************************************************
 * "enabledaccounts" preference changed
 ******************************************************************************/
function preferenceDisabledAccountsChanged(value)
{
    THREADVIS_ENABLEDACCOUNTS_ = value;
    createThreadVis();
    THREADVIS_.doLoad.onStartHeaders();
}



/** ****************************************************************************
 * "enabled" preference changed
 ******************************************************************************/
function preferenceEnabledChanged(value)
{
    THREADVIS_ENABLED_ = value;
    createThreadVis();
}



/** ****************************************************************************
 * "disabledfolders" preference changed
 ******************************************************************************/
function preferenceDisabledFoldersChanged(value)
{
    THREADVIS_DISABLEDFOLDERS_ = value;
    createThreadVis();
    THREADVIS_.doLoad.onStartHeaders();
}



/** ****************************************************************************
 * Called when a message is selected
 * Call visualisation with messageid to visualise
 ******************************************************************************/
ThreadVis.prototype.setSelectedMessage = function()
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
    {
        this.clearVisualisation();
        return;
    }


    LOGGER_.logDebug(LOGGER_.LEVEL_INFORM_, "ThreadVis.setSelectedMessage()", {});
    if (! this.loaded_ || ! this.threaded_)
    {
        var ref = this;
        setTimeout(function(){ref.setSelectedMessage();}, 100);
        this.clearVisualisation();
        return;
    }
    this.clear_ = false;

    // get currently loaded message
    var msg_uri = GetLoadedMessage();
    var msg = messenger.messageServiceFromURI(msg_uri)
              .messageURIToMsgHdr(msg_uri);

    // only log as a "user" select if this message was not already
    // selected by the extension
    if (this.selected_msgkey_ != msg.messageKey)
    {
        LOGGER_.log("msgselect",
                    {"from" : "user",
                     "key" : msg.messageKey});
    }

    if (this.server_.key != msg.folder.server.key)
    {
        LOGGER_.log("switchaccount", {});
        // user just switched account
        this.loaded_ = false;
        this.threaded_ = false;
        this.threader_ = new Threader();
        this.doLoad.onStartHeaders();
    }

    // call threader
    // fixxme delay display
    // to give UI time to layout
    var ref = this;
    setTimeout(function(){ref.visualiseMsgId(msg.messageId);}, 100);
}



/** ****************************************************************************
 * close log file on unload
 ******************************************************************************/
ThreadVis.prototype.unloadHandler = function()
{
    LOGGER_.log("threadvis",
        {"action": "unload"});
    LOGGER_.close();
    this.threader_.closeCopyCut();
}



/** ****************************************************************************
 * Visualise a container
 ******************************************************************************/
ThreadVis.prototype.visualise = function(container)
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return

    LOGGER_.logDebug(LOGGER_.LEVEL_INFORM_, "ThreadVis.visualise()",
                        {"container" : container});

    var msgkey = container.isDummy() ? 
                    "DUMMY" : 
                    container.getMessage().getKey();
    var topcontainer_msgKey = container.getTopContainer().isDummy() ? 
                                    "DUMMY" : 
                                    container.getTopContainer().getMessage().getKey();
    var msgcount = container.getTopContainer().getCountRecursive();

    LOGGER_.log("visualise",
                    {"msgkey" : msgkey,
                     "top container" : topcontainer_msgKey,
                     "msgcount" : msgcount});

    this.visualisation_.visualise(container);
    this.selected_container_ = container;
}



/** ****************************************************************************
 * visualise a message id
 * find the container
 * call method visualise(container)
 ******************************************************************************/
ThreadVis.prototype.visualiseMsgId = function(message_id)
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return


    LOGGER_.logDebug(LOGGER_.LEVEL_INFORM_, "ThreadVis.visualiseMsgId()",
                        {"message-id" : message_id});

    var container = this.threader_.findContainer(message_id);

    if (container != null && ! container.isDummy())
    {
        this.visualise(container);
        
        // visualise any popup windows that might exist
        if (POPUP_WINDOW_ && POPUP_WINDOW_.THREADVIS_)
            POPUP_WINDOW_.THREADVIS_.visualise(container);
    }
    else
    {
        // - message id not found, or
        // - container with id was dummy
        // this means we somehow missed to thread this message
        // thus, thread the whole folder we are in
        this.clearVisualisation();
        if (POPUP_WINDOW_ && POPUP_WINDOW_.THREADVIS_)
            POPUP_WINDOW_.THREADVIS_.clearVisualisation();
        this.onFolderAdded(GetLoadedMsgFolder());
    }
    container = null;
}



/** ****************************************************************************
 * Wait until all messages are added
 ******************************************************************************/
ThreadVis.prototype.waitForAddMessages = function()
{
    if (! THREADVIS_ENABLED_)
        return;
    
    if (! this.checkEnabledAccountOrFolder())
        return;

    if (this.add_messages_done_)
    {
        this.loaded_ = true;
        this.loading_ = false;
        this.add_messages_end_time = new Date();
        var duration = this.add_messages_end_time - this.add_messages_start_time;
        LOGGER_.log("addmessages", {"action" : "end", "time" : duration});
        return;
    }

    // if we are already adding messages, wait until we are finished
    // to look at new folder
    if (this.add_messages_from_folder_doing_)
    {
        var ref = this;
        setTimeout(function(){ref.waitForAddMessages();}, 10);
        return;
    }


    // look at next folder
    var folder = this.folders_.shift();
    LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.waitForAddMessages()",
                        {"action" : "next folder",
                         "folder" : folder});

    // if folder == null, we don't have any folders left to look at
    if (folder == null)
    {
        this.add_messages_done_ = true;
    }
    else
    {
        this.add_messages_from_folder_doing_ = true;
        this.add_messages_from_folder_done_ = false;
        this.addMessagesFromFolder(folder);
    }

    var ref = this;
    setTimeout(function(){ref.waitForAddMessages();}, 10);
}



/** ****************************************************************************
 * wait for all messages to be added
 * then start threading
 ******************************************************************************/
ThreadVis.prototype.waitForThreading = function()
{
    if (! THREADVIS_ENABLED_)
        return;
    if (! this.checkEnabledAccountOrFolder())
        return


    LOGGER_.logDebug(LOGGER_.LEVEL_EMAIL_, "ThreadVis.waitForThreading()", {});

    if (this.loaded_ &&
        ! this.threaded_ &&
        ! this.threading_)
    {
        var ref = this;
        setTimeout(function(){ref.doThreading();}, 100);
    }
    else if (! this.threaded_ &&
             ! this.threading_)
    {
        var ref = this;
        setTimeout(function(){ref.waitForThreading();}, 100);
    }
}



/** ****************************************************************************
 * display a popup window for the visualisation
 ******************************************************************************/
function displayVisualisationWindow()
{
    POPUP_WINDOW_ = window.openDialog("chrome://threadvis/content/ThreadVisPopup.xul");
    // get currently loaded message
    var msg_uri = GetLoadedMessage();
    var msg = messenger.messageServiceFromURI(msg_uri)
              .messageURIToMsgHdr(msg_uri);

    setTimeout(function() {POPUP_WINDOW_.THREADVIS_.visualiseMsgId(msg.messageId);}, 1000);
}



/** ****************************************************************************
 * log all JavaScript errors to logfile
 ******************************************************************************/
window.onerror = logJavaScriptErrors;
function logJavaScriptErrors(message, file, line)
{
    LOGGER_.log("threadvis-jserror", {"message": message,
                                      "file" : file,
                                      "line" : line});
}