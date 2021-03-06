//Create a server using express.
var app = require('express')();
var PORT = 3000;
var TLS_PORT = 8000;
var HOST = 'localhost';
var tls = require('tls');
var fs = require('fs');
var bodyParser = require('body-parser');
var mongoose = require('mongoose');
var os  = require('os-utils');
var GeoPoint = require('geopoint');
//specify the self-signed public certificate and the private key used
var key = fs.readFileSync('./private-key.pem');
var cert = fs.readFileSync('./public-cert.pem');
var options = {
	key : key,
	cert : cert,
	ca  : [ fs.readFileSync('./client-public-cert.pem')]
};
//Adding a library to convert ist timestamp to unix timestamp
var moment = require('moment');
moment().format();
var OVERSPEED_LIMIT = 4,STAT_LIMIT = 12, AVG_SPEED = 60, STAT_SPEED = 0, GEO_RANGE = 10;

//Connect to mongodb instance
mongoose.connect('mongodb://127.0.0.1:27017/devicestatistics');

//Attach lister to validate successfull connection
mongoose.connection.once('connected', function() {
	console.log("Connected to database successfully using mongoose");

});

var Schema = mongoose.Schema
, ObjectId = Schema.ObjectID;

//Create a object schema to store device information
var DeviceTrack = new Schema({
	Device_identity      : { type: String, required: true },
	Latitude             : Number,
	Longitude            : Number,
	Timestamp            : Number,
	Status               : { type: String, required: true },
	Speed                : { type: Number, required: true }
});

//Create a object schema for cpu utilization 
var SystemHealth = new Schema({
	CpuUtilization : Number,
	MemUtilization : Number,
	Timestamp      : Number 
});

var DeviceTrack = mongoose.model('DeviceTrack', DeviceTrack); 
var SystemHealth = mongoose.model('SystemHealth', SystemHealth);    

//Create a secured https server using the options for level 2 tasks
var https = require('https').createServer(options, app);

//Create a tls server using the options for level 1 task
var tlsserver = tls.createServer(options, function (serverSocket) {

  serverSocket.write("Echo device..." + "\n");
  serverSocket.pipe(serverSocket);
  //Add a listener for client data being received
  serverSocket.addListener("data", function (data) {
	console.log('Device Statistics received from :  Device-' + serverSocket.remotePort);
	var jsondataObject = JSON.parse(data);
	jsondataObject.Timestamp = generateUnixTimeStamp(jsondataObject.Date, jsondataObject.Time);
	//Insert the data sent by client into our mongodb database
	var deviceTrack = new DeviceTrack(jsondataObject);
         
	        deviceTrack.save( function(error, data){
	            if(error){
	            	console.log('Error occured while saving in db ' + error);
	            }
	            else{
	            	console.log('Storing in db..');
	            }
	        });
    });

}).listen(TLS_PORT);

//We require body parser to get json data from https post requests
app.use(bodyParser.urlencoded({ extended: true }));
//Inorder for the request body to be parsed by the https post method we need to use the below line 
app.use(bodyParser.json());

//Create API(s) to handle all the incoming https requests(Level 2 tasks)
//Task 1.API to get cpu utilization % and memory utilization % for a time range
app.post('/tracker/fetchLocalSysHealth', function(request, response){
	//Find all the records from db between the time range 
	SystemHealth.find({
    Timestamp: {
        $gte: moment(request.body.starttime).unix(),
        $lt: moment(request.body.stoptime).unix()
    }}, function(err, healthStats){
	//find avg of them all
	totalCPUtil = totalmemUtilization = 0;
	for (var i = 0, len = healthStats.length; i < len; i++) {
		totalCPUtil = totalCPUtil + healthStats[i].CpuUtilization; 
		totalmemUtilization = totalmemUtilization + healthStats[i].MemUtilization;
	}
	//Send % response to client
	response.status(200).json({ "CpuUtilization":totalCPUtil/healthStats.length, "MemUtilization":totalmemUtilization/healthStats.length});
    }); 
});

//Task 2.API to get list of devices on the system
app.get('/tracker/listDevicesOnSystem', function(request, response){
console.log('Fetching list of devices connected on system');
DeviceTrack.distinct("Device_identity",(function(err, devices){
	if(devices.length == 0){
		response.json({count : 0 });
	}
	else if(err){
		console.log('Error occured while fetching list of devices on system');
	}else{
		response.json(devices);
	}
}));
});

//Task 3.API to get positions between time ranges
app.post('/tracker/getDevicePositions', function(request, response){
	DeviceTrack.find({ Device_identity : request.body.Device_identity, Timestamp : {
        $gte: moment(request.body.starttime).unix(),
        $lt: moment(request.body.stoptime).unix()
    }}, function(err, deviceReadings){
		if(deviceReadings.length == 0){
		response.json({count : 0 });
		}else if(err){
			console.log('Error occured while fetching device data due to' + err);
		}else{
			response.json(deviceReadings);
		}
	});
});
//Task 4.API to get list of devices having speed more than 60 for more than 40 seconds within a specific time range
app.post('/tracker/getOverSpeedingDevices', function(request, response){
	DeviceTrack.find({ Timestamp : {$gte: moment(request.body.starttime).unix(),
	$lt: moment(request.body.stoptime).unix()}, Speed: { $gt: AVG_SPEED }}).distinct("Device_identity", function(err, uniqueDevices){
		if(uniqueDevices.length == 0){
			response.json({count : 0 });
		}
		var finalList = [];
		var device_trv_count = 0;
		uniqueDevices.forEach(function (device) {

			DeviceTrack.find({ Device_identity : device, Timestamp : {$gte: moment(request.body.starttime).unix(),
			$lt: moment(request.body.stoptime).unix()}, Speed : {$gt: AVG_SPEED}}, function(err, deviceSpecificData){ 
				ContSpeedCounter = timestamp_Previous = 0;
				continuousTimeStamp = timestamp_reset = true;	
				deviceSpecificData.forEach(function (deviceData) {
				//Check if the difference between previous timestamp and current timestamp is 10
				if(timestamp_reset){
					//for initial condition and when timestamps are not continuous inbetween and 40 seconds criteria not met
					continuousTimeStamp = true;
					timestamp_reset = false;
				}else if((deviceData.Timestamp - timestamp_Previous) == 10){
					continuousTimeStamp = true;
				}
				else {
					continuousTimeStamp = false; 
				}
				if(!continuousTimeStamp){
					ContSpeedCounter = 0;
					timestamp_reset = true;
				}
				else{
					ContSpeedCounter++;
				}
				if(ContSpeedCounter > OVERSPEED_LIMIT){
					finalList.push(deviceData.Device_identity);
					ContSpeedCounter = 0;
				}
				timestamp_Previous = deviceData.Timestamp;
				});	 	 
				device_trv_count++;
				//Once all the unique devices are analyzed for overspeedding send the response
				if(device_trv_count == uniqueDevices.length){
				response.json(finalList);
				}
				});
			});       
	});
});

//Task5. API for Geo Dwell
app.post('/tracker/GeoDwell', function(request, response){
	DeviceTrack.find({Timestamp : {$gte: moment(request.body.starttime).unix(),
	$lt: moment(request.body.stoptime).unix()}}).distinct("Device_identity", function(err, uniqueDevices){
		//fetched a unique list of devices in the specified time range 
		if(uniqueDevices.length == 0){
			response.json({count : 0 });
		}
		try{
			QueryPoint = new GeoPoint(request.body.Latitude, request.body.Longitude);
			var inrangeDeviceList = [];
			var device_trv_count = 0;
			uniqueDevices.forEach(function(device){
				DeviceTrack.find({ Device_identity : device, Timestamp : {$gte: moment(request.body.starttime).unix(),
				$lt: moment(request.body.stoptime).unix()}}, function(err, deviceSpecificData){
				//For each device data reading check whether in the range of query point
				deviceSpecificData.every(function(devicedata){
					var currentPoint = new GeoPoint(devicedata.Latitude, devicedata.Longitude);
					if(QueryPoint.distanceTo(currentPoint, true) < GEO_RANGE){
						inrangeDeviceList.push(devicedata.Device_identity);
						return false;
					}
					return true;
				});
				device_trv_count++;
				//Once all the unique devices are analyzed for overspeedding send the response
				if(device_trv_count == uniqueDevices.length){
					response.json(inrangeDeviceList);
				}
				});			
			});
		}catch(ex){
			console.log('Error Occured due to : ' + ex);
			response.status(403).json('{ error : "Invalid params/missing params"}');
		}
	});
});

//Task 6. API Stationary Filter : get list of devices stationary for more than 2 minutes
app.post('/tracker/getstationaryDevices', function(request, response){
	DeviceTrack.find({ Timestamp : {$gte: moment(request.body.starttime).unix(),
	$lt: moment(request.body.stoptime).unix()}, Speed: STAT_SPEED }).distinct("Device_identity", function(err, uniqueDevices){
		if(uniqueDevices.length == 0){
			response.json({count : 0 });
		}
		var finalStationaryDevList = [];
		var device_trv_count = 0;
		uniqueDevices.forEach(function (device) {
			DeviceTrack.find({ Device_identity : device, Timestamp : {$gte: moment(request.body.starttime).unix(),
			$lt: moment(request.body.stoptime).unix()}, Speed : STAT_SPEED}, function(err, deviceSpecificData){ 
				ContSpeedCounter = timestamp_Previous = 0;
				stat_min_limit = deviceIdentified = false;
				continuousTimeStamp = timestamp_reset = true;	
				deviceSpecificData.forEach(function (deviceData) {
			    //Check if the difference between previous timestamp and current timestamp is 10
				if(timestamp_reset){
				//for initial condition and when timestamps are not continuous inbeween and 2 min criteria not met
				continuousTimeStamp = true;
				timestamp_reset = false;
				}else if((deviceData.Timestamp - timestamp_Previous) == 10){
				continuousTimeStamp = true;
				}
				else {
				continuousTimeStamp = false; 
				}

				if (stat_min_limit && !continuousTimeStamp){
                    var Deviceobj = { device: deviceData.Device_identity, 
					duration: ContSpeedCounter/6};                     	 
					finalStationaryDevList.push(Deviceobj);
					ContSpeedCounter = 0;
					stat_min_limit = false;
					deviceIdentified = true;
				}
				else if(!continuousTimeStamp && !stat_min_limit){
					ContSpeedCounter = 0;
					timestamp_reset = true;
				}
			    else{
			    	ContSpeedCounter++;
			    }

				if(ContSpeedCounter > STAT_LIMIT && !stat_min_limit){
					stat_min_limit = true;
				}
					timestamp_Previous = deviceData.Timestamp;
				});
                //we need to handle condition when device was stationary for the duration continuosly
                 if(!deviceIdentified && stat_min_limit){
                   var Deviceobj = { device: device, 
					duration: ContSpeedCounter/6}; 
					finalStationaryDevList.push(Deviceobj);
                 }
				device_trv_count++;
				//Once all the unique devices are analyzed for being stationary for more than 2 minutes(120 seconds) send the response
				if(device_trv_count == uniqueDevices.length){
					response.json(finalStationaryDevList);
				}
				});
			});       
	});
});

//The http server created should listen on a port for clients
https.listen(PORT, HOST);
//Function to return unix timestamp from the IST date and time
function generateUnixTimeStamp(Date, Time){

	return  moment(Date + 'T' +Time).unix();

};
//Executing the function every 1 minute to fetch CPU utilization % and then store in db as unix timestamp
setInterval(function(){
	//Need to store timestamp of current time with CPU utilization
	os.cpuUsage(function(v){
		CpuStatus = {
			CpuUtilization : v,
			MemUtilization : 100 - os.freememPercentage(),
			Timestamp      : moment(moment()).unix()
		};
		//Insert cpu data into database
		var systemHealth = new SystemHealth(CpuStatus);
		systemHealth.save( function(error, data){
			if(error){
			console.log('Error occured while saving CPU data in db ' + error);
			}
		});
    });
}, 60* 1000);

console.log('tls Server is runnning on port : ' + TLS_PORT);
console.log('secure https server running on port : ' + PORT);